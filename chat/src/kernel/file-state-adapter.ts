/**
 * file-state-adapter.ts — chat SDK `StateAdapter` 의 파일기반 구현(FileStateAdapter).
 *
 * chat SDK 는 스레드 구독 영속화·분산 락(중복처리 방지)·캐시(모달 컨텍스트/dedupe)·큐를
 * `StateAdapter`(18 메서드) 로 위임한다. core 에는 상태 어댑터가 없어(별도 Redis 패키지) 우리
 * 파일 하네스에 정합하도록 **파일기반**으로 구현한다. 저장 루트 = `storagePaths().state`(chat/.state/).
 *
 * 설계 원칙:
 *   · 원자 쓰기 = tmp 파일 + rename(같은 파일시스템에서 원자적) → 부분 쓰기가 읽기에 노출되지 않는다.
 *   · 락 = write-tmp + `link()` 원자 생성(내용 완비 · 빈 파일 창 없음)으로 동시 다중 획득 중 정확히 하나만 성공,
 *     만료(expiresAt) 락은 `rename()` 원자 회수(한 명만 성공)로 재획득 — 멀티프로세스 공유 state 에서도 이중 진입 없음.
 *   · TTL = 저장 레코드에 만료 epoch(ms)를 심고, 조회 시 만료분은 없는 것으로 취급(+ 지연 청소).
 *   · 키 → 파일명 = 슬래시·콜론 등 비안전 문자를 %XX 로 이스케이프(경로 탈출 불가; `.`/`/` 산출 안 됨).
 *   · 대상 배포 = **단일 상주 프로세스**(grounding). 프로세스-내 경합은 KeyedMutex 로 직렬화하고,
 *     신규 락 생성의 교차-프로세스 중재는 O_EXCL 이 담당한다(다인스턴스면 Redis 권장).
 */
import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Lock, QueueEntry, StateAdapter } from "chat";
import { storagePaths } from "../config.js";

/** 저장 레코드(내부 포맷) — 값 캐시. e = 만료 epoch(ms) 또는 null(무기한). */
interface KvRecord {
  v: unknown;
  e: number | null;
}
/** 저장 레코드 — 리스트. e = 만료 epoch(ms) 또는 null. */
interface ListRecord {
  items: unknown[];
  e: number | null;
}
/** 저장 레코드 — 스레드별 FIFO 큐. */
interface QueueRecord {
  items: QueueEntry[];
}
/** 저장 레코드 — 락(디스크 표현). Lock 과 동형. */
interface LockRecord {
  token: string;
  threadId: string;
  expiresAt: number;
}

/** ENOENT(없음) 판정. */
function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === "ENOENT";
}
/** EEXIST(이미 있음) 판정 — O_EXCL 생성 충돌. */
function isExists(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === "EEXIST";
}
/** 만료 여부. e=null 이면 무기한(만료 아님). */
function isExpired(e: number | null | undefined, now = Date.now()): boolean {
  return e != null && now >= e;
}
/** ENOENT 는 무시하고 그 외 오류만 전파(멱등 삭제용). */
function rethrowUnlessMissing(err: unknown): void {
  if (!isMissing(err)) throw err;
}

/**
 * 키(임의 문자열) → 파일시스템 안전 이름. 비-[0-9A-Za-z_-] 바이트를 %XX 로 이스케이프한다.
 * 산출물은 오직 `[0-9A-Za-z_-]` 와 `%XX` 만 포함 → `.`/`..`/`/`/`\` 가 절대 나오지 않아 경로 탈출 불가.
 * 파일명 길이 한계(≈255) 방어: 너무 길면 접두부 + sha256 해시로 대체(열거가 없으므로 역변환 불요).
 */
function encodeKey(key: string): string {
  let out = "";
  for (const b of Buffer.from(key, "utf8")) {
    const safe =
      (b >= 0x30 && b <= 0x39) || // 0-9
      (b >= 0x41 && b <= 0x5a) || // A-Z
      (b >= 0x61 && b <= 0x7a) || // a-z
      b === 0x2d || // -
      b === 0x5f; // _
    out += safe
      ? String.fromCharCode(b)
      : "%" + b.toString(16).toUpperCase().padStart(2, "0");
  }
  if (out.length > 200) {
    const h = createHash("sha256").update(key).digest("hex").slice(0, 32);
    out = out.slice(0, 160) + "-" + h;
  }
  return out;
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}
async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch (err) {
    if (isMissing(err)) return false;
    throw err;
  }
}

/**
 * 프로세스-내 키별 직렬화 뮤텍스. 같은 key 의 임계구역을 한 번에 하나만 실행시킨다.
 * (JS 단일스레드라 조건검사~lock 세팅 사이 await 가 없으므로 이중 진입이 없다.)
 * 락 변형·리스트/큐의 read-modify-write 원자성을 프로세스-내에서 보장한다.
 */
class KeyedMutex {
  private readonly held = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    while (this.held.has(key)) {
      try {
        await this.held.get(key);
      } catch {
        /* 이전 작업의 오류는 다음 작업에 영향 없음 */
      }
    }
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    this.held.set(key, gate);
    try {
      return await fn();
    } finally {
      this.held.delete(key);
      release();
    }
  }
}

/** chat SDK `StateAdapter` 의 파일기반 구현. */
export class FileStateAdapter implements StateAdapter {
  private readonly root: string;
  private readonly mutex = new KeyedMutex();

  /** root 미지정 시 `storagePaths().state`(chat/.state/). 테스트는 임시 디렉터리를 주입한다. */
  constructor(root?: string) {
    this.root = root ?? storagePaths().state;
  }

  // ── 경로 빌더(키는 안전 인코딩) ──────────────────────────────────────────
  private kvPath(key: string): string {
    return join(this.root, "kv", `${encodeKey(key)}.json`);
  }
  private listPath(key: string): string {
    return join(this.root, "list", `${encodeKey(key)}.json`);
  }
  private queuePath(threadId: string): string {
    return join(this.root, "queue", `${encodeKey(threadId)}.json`);
  }
  private lockPath(threadId: string): string {
    return join(this.root, "lock", `${encodeKey(threadId)}.lock`);
  }
  private subPath(threadId: string): string {
    return join(this.root, "sub", encodeKey(threadId));
  }

  // ── 저수준 IO ────────────────────────────────────────────────────────────
  /** tmp + rename 원자 쓰기. 부모 디렉터리는 보장한다. */
  private async atomicWrite(file: string, data: string): Promise<void> {
    await ensureDir(dirname(file));
    const tmp = `${file}.${randomUUID()}.tmp`;
    await writeFile(tmp, data, "utf8");
    await rename(tmp, file);
  }
  /** ENOENT/손상 파일 → null. 그 외 읽기 오류는 전파. */
  private async readJson<T>(file: string): Promise<T | null> {
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null; // 손상/빈 파일은 캐시-미스로 취급
    }
  }

  // ── 연결 수명주기 ─────────────────────────────────────────────────────────
  async connect(): Promise<void> {
    await Promise.all(
      ["kv", "list", "queue", "lock", "sub"].map((sub) => ensureDir(join(this.root, sub))),
    );
  }
  async disconnect(): Promise<void> {
    /* 상주 연결 없음 — no-op */
  }

  // ── 키-값 캐시 ────────────────────────────────────────────────────────────
  async get<T = unknown>(key: string): Promise<T | null> {
    const file = this.kvPath(key);
    const rec = await this.readJson<KvRecord>(file);
    if (!rec) return null;
    if (isExpired(rec.e)) {
      // 만료분 지연 청소 — 동시 set() 이 갓 쓴 값을 지우지 않도록 같은 키 뮤텍스로 직렬화 + 재확인.
      //   락 안에서 다시 읽어 '여전히 만료'일 때만 삭제(그 사이 fresh set 이 들어왔으면 건너뜀).
      await this.mutex.run(`kv:${key}`, async () => {
        const cur = await this.readJson<KvRecord>(file);
        if (cur && isExpired(cur.e)) await unlink(file).catch(rethrowUnlessMissing);
      });
      return null;
    }
    return rec.v as T; // 비만료 읽기는 락 없이(핫패스)
  }
  async set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void> {
    // 만료 청소(get)·setIfNotExists 와 같은 키 뮤텍스로 배타 — fresh write 유실 방지.
    await this.mutex.run(`kv:${key}`, async () => {
      const rec: KvRecord = { v: value, e: ttlMs != null ? Date.now() + ttlMs : null };
      await this.atomicWrite(this.kvPath(key), JSON.stringify(rec));
    });
  }
  async delete(key: string): Promise<void> {
    await unlink(this.kvPath(key)).catch(rethrowUnlessMissing);
  }
  async setIfNotExists(key: string, value: unknown, ttlMs?: number): Promise<boolean> {
    return this.mutex.run(`kv:${key}`, async () => {
      const file = this.kvPath(key);
      const rec = await this.readJson<KvRecord>(file);
      if (rec && !isExpired(rec.e)) return false; // 유효값 존재 → 설정 안 함
      const next: KvRecord = { v: value, e: ttlMs != null ? Date.now() + ttlMs : null };
      await this.atomicWrite(file, JSON.stringify(next));
      return true;
    });
  }

  // ── 락(원자 생성 + TTL) ──────────────────────────────────────────────────
  async acquireLock(threadId: string, ttlMs: number): Promise<Lock | null> {
    return this.mutex.run(`lock:${threadId}`, async () => {
      const file = this.lockPath(threadId);
      await ensureDir(dirname(file));
      const cur = await this.readJson<LockRecord>(file);
      if (cur && !isExpired(cur.expiresAt)) return null; // 유효 락 존재 → 획득 실패
      // ⚠ cur===null(손상)은 unlink 하지 않는다 — link 기반 생성은 '쓰기 중 빈 파일'을 만들지 않으므로,
      //   parse-null 존재 파일은 청소 대신 '점유 중'으로 취급(EEXIST→null)해 이중 획득을 원천 차단.
      if (cur && isExpired(cur.expiresAt)) {
        // 만료 락 **원자 회수**: 이 파일을 rename 으로 '훔친' 정확히 한 명만 성공(나머지 ENOENT).
        //   두 경쟁자가 같은 만료 레코드를 읽어도 rename 성공자만 재생성 자격을 얻어, 남의 fresh 락을
        //   stale 판단으로 unlink 하던 레이스를 없앤다(멀티프로세스 안전; 단일 프로세스는 뮤텍스로 이미 직렬).
        const stolen = `${file}.expired-${randomUUID()}`;
        try {
          await rename(file, stolen);
        } catch (err) {
          if (isMissing(err)) return null; // 다른 경쟁자가 먼저 회수 → 지금은 점유로 취급(호출자 재시도)
          throw err;
        }
        await unlink(stolen).catch(() => {});
      }
      // 원자 생성(내용과 함께): tmp 에 락을 '먼저 다 쓰고' link 로 배타 생성 → O_EXCL 의 '빈 파일 창'이 없다.
      //   동시 획득 중 정확히 하나만 link 성공(나머지 EEXIST → null). 다른 프로세스가 빈 파일을 보고 지우는 레이스 소멸.
      const lock: LockRecord = { token: randomUUID(), threadId, expiresAt: Date.now() + ttlMs };
      const tmp = `${file}.tmp-${randomUUID()}`;
      await writeFile(tmp, JSON.stringify(lock), "utf8");
      try {
        await link(tmp, file); // 원자적 배타 생성(내용 이미 완비)
        return lock;
      } catch (err) {
        if (isExists(err)) return null; // 그 사이 타 획득자가 link 성공
        throw err;
      } finally {
        await unlink(tmp).catch(() => {}); // tmp 정리(실패 무시)
      }
    });
  }
  async releaseLock(lock: Lock): Promise<void> {
    await this.mutex.run(`lock:${lock.threadId}`, async () => {
      const file = this.lockPath(lock.threadId);
      const cur = await this.readJson<LockRecord>(file);
      if (cur && cur.token === lock.token) {
        await unlink(file).catch(rethrowUnlessMissing); // 토큰 일치 시만 해제
      }
    });
  }
  async extendLock(lock: Lock, ttlMs: number): Promise<boolean> {
    return this.mutex.run(`lock:${lock.threadId}`, async () => {
      const file = this.lockPath(lock.threadId);
      const cur = await this.readJson<LockRecord>(file);
      if (!cur || cur.token !== lock.token || isExpired(cur.expiresAt)) return false;
      const expiresAt = Date.now() + ttlMs;
      await this.atomicWrite(file, JSON.stringify({ ...cur, expiresAt } satisfies LockRecord));
      lock.expiresAt = expiresAt; // 호출자의 Lock 도 최신화
      return true;
    });
  }
  async forceReleaseLock(threadId: string): Promise<void> {
    await this.mutex.run(`lock:${threadId}`, async () => {
      await unlink(this.lockPath(threadId)).catch(rethrowUnlessMissing);
    });
  }

  // ── 스레드 구독(영속) ─────────────────────────────────────────────────────
  async subscribe(threadId: string): Promise<void> {
    await this.atomicWrite(this.subPath(threadId), JSON.stringify({ subscribedAt: Date.now() }));
  }
  async unsubscribe(threadId: string): Promise<void> {
    await unlink(this.subPath(threadId)).catch(rethrowUnlessMissing);
  }
  async isSubscribed(threadId: string): Promise<boolean> {
    return pathExists(this.subPath(threadId));
  }

  // ── 스레드별 FIFO 큐 ──────────────────────────────────────────────────────
  async enqueue(threadId: string, entry: QueueEntry, maxSize: number): Promise<number> {
    return this.mutex.run(`queue:${threadId}`, async () => {
      const file = this.queuePath(threadId);
      const rec = (await this.readJson<QueueRecord>(file)) ?? { items: [] };
      rec.items.push(entry);
      while (maxSize > 0 && rec.items.length > maxSize) rec.items.shift(); // 오래된 것부터 폐기
      await this.atomicWrite(file, JSON.stringify(rec));
      return rec.items.length;
    });
  }
  async dequeue(threadId: string): Promise<QueueEntry | null> {
    return this.mutex.run(`queue:${threadId}`, async () => {
      const file = this.queuePath(threadId);
      const raw = await this.readJson<QueueRecord>(file);
      const rec = raw ?? { items: [] };
      const now = Date.now();
      let next: QueueEntry | null = null;
      while (rec.items.length > 0) {
        const cand = rec.items.shift() as QueueEntry;
        if (isExpired(cand.expiresAt, now)) continue; // 만료 엔트리 폐기
        next = cand;
        break;
      }
      if (raw !== null || next !== null) await this.atomicWrite(file, JSON.stringify(rec));
      return next;
    });
  }
  async queueDepth(threadId: string): Promise<number> {
    // 만료 엔트리는 세지 않는다 — SDK 가 enqueue 전 maxSize 강제에 이 값을 쓰므로(onQueueFull),
    // 만료분만 남은 큐가 신규 메시지를 부당하게 드롭하는 것을 막는다. (읽기 전용 — 정리는 dequeue 담당.)
    const rec = await this.readJson<QueueRecord>(this.queuePath(threadId));
    if (!rec) return 0;
    const now = Date.now();
    return rec.items.filter((e) => !isExpired(e.expiresAt, now)).length;
  }

  // ── 리스트(append-only) ───────────────────────────────────────────────────
  async appendToList(
    key: string,
    value: unknown,
    options?: { maxLength?: number; ttlMs?: number },
  ): Promise<void> {
    await this.mutex.run(`list:${key}`, async () => {
      const file = this.listPath(key);
      const cur = await this.readJson<ListRecord>(file);
      const items = cur && !isExpired(cur.e) ? cur.items : [];
      items.push(value);
      const max = options?.maxLength;
      if (max != null && max > 0) while (items.length > max) items.shift(); // 최신 유지
      const rec: ListRecord = {
        items,
        e: options?.ttlMs != null ? Date.now() + options.ttlMs : null, // TTL 갱신
      };
      await this.atomicWrite(file, JSON.stringify(rec));
    });
  }
  async getList<T = unknown>(key: string): Promise<T[]> {
    const rec = await this.readJson<ListRecord>(this.listPath(key));
    if (!rec || isExpired(rec.e)) return [];
    return rec.items as T[];
  }
}
