/**
 * transport.test.ts — 인터랙션 배선(wireInteractionHandlers) 단위(S-7).
 *
 * ── 무엇을 검증하나 ─────────────────────────────────────────────────────────────────
 *   createBot 에서 뽑아낸 wireInteractionHandlers 가 Slack 이벤트 4개(DM/멘션/버튼/답글)를 중립 이벤트로 번역해
 *   **같은 게이트웨이**로 위임하는지를 **구조적 fake**로 못 박는다(실 Slack 연결 0 · 오프라인 결정론). 라이브 백엔드
 *   (assembleLiveBackend)도 이 함수를 호출하므로, 실 사람 클릭/답글이 드라이버 fire 와 같은 계약(onAction/onReply)으로
 *   들어옴을 이 단위가 대신 확증한다(assembleLiveBackend 는 isOffline 이면 throw 라 직접 호출 불가 — 배선 라인만 추가).
 *
 * ── fake 구성(실 커널 위임 통합) ─────────────────────────────────────────────────────
 *   · fakeChat: 4개 등록 메서드가 핸들러를 기록만 한다(등록 확인 + 콜백 직접 호출).
 *   · recordingGw: 실 onMention/onAction/onReply(커널)가 실제로 도는 최소 게이트웨이 — 어느 경로를 탔는지
 *     부수효과(queue.submit·chat.subscribe·pending.mergeSetup·chat.render)로 판별한다. flow.test.ts 가 커널 로직을
 *     이미 깊게 덮으므로 여기선 **배선(이벤트→중립 이벤트→위임)**만 확인한다(과검증 금지).
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  ActionEvent,
  ActionHandler,
  Chat,
  DirectMessageHandler,
  MentionHandler,
  Message,
  SubscribedMessageHandler,
  Thread,
} from "chat";
import { buildSlackChatPort, wireInteractionHandlers } from "../../../src/adapters/slack/transport.js";
import type { ImageOptionSetPresentation } from "../../../src/kernel/presentation.js";
import type { Gateway } from "../../../src/kernel/flow.js";
import type { Job } from "../../../src/types/jobs.js";
import type { Presentation } from "../../../src/kernel/presentation.js";

/** 기록된 핸들러(등록 순서·존재 확인 + 콜백 직접 호출용). */
interface Recorded {
  dm?: DirectMessageHandler;
  mention?: MentionHandler;
  action?: ActionHandler;
  subscribed?: SubscribedMessageHandler;
}

/** fake Chat — 4개 등록 메서드가 핸들러를 잡아둔다(연결/전송 없음). */
function makeFakeChat(): { chat: Chat; h: Recorded; order: string[] } {
  const h: Recorded = {};
  const order: string[] = [];
  const chat = {
    onDirectMessage: (fn: DirectMessageHandler) => {
      h.dm = fn;
      order.push("dm");
    },
    onNewMention: (fn: MentionHandler) => {
      h.mention = fn;
      order.push("mention");
    },
    onAction: (fn: ActionHandler) => {
      h.action = fn;
      order.push("action");
    },
    onSubscribedMessage: (fn: SubscribedMessageHandler) => {
      h.subscribed = fn;
      order.push("subscribed");
    },
  } as unknown as Chat;
  return { chat, h, order };
}

/** recordingGw 가 노출하는 관측 기록(경로 판별용 부수효과). */
interface GwCalls {
  submitted: Job[];
  rendered: { threadId: string; type: string }[];
  subscribed: string[];
  pendingSet: unknown[];
  mergeSetup: unknown[];
  runForThreadCount: number;
}

type Pending = { kind: string; [k: string]: unknown } | null;

/**
 * 최소 recording 게이트웨이 — 실 onMention/onAction/onReply 가 도는 데 필요한 표면만 구현하고 호출을 기록한다.
 *   pending/runForThread 초기값을 주입해 분기(멘션 재진입 vs 답글 소비 · 설정 수집)를 결정론적으로 유도한다.
 */
function makeRecordingGw(init?: { pending?: Pending; runForThread?: string | null }): { gw: Gateway; calls: GwCalls } {
  const calls: GwCalls = {
    submitted: [],
    rendered: [],
    subscribed: [],
    pendingSet: [],
    mergeSetup: [],
    runForThreadCount: 0,
  };
  let pending: Pending = init?.pending ?? null;
  const gw = {
    queue: {
      submit: async (job: Job) => {
        calls.submitted.push(job);
      },
    },
    map: {
      runForThread: async () => {
        calls.runForThreadCount++;
        return init?.runForThread ?? null;
      },
      threadForRun: async () => null,
      bindThreadToRun: async () => {},
    },
    pending: {
      get: async () => pending,
      set: async (_tid: string, rec: Pending) => {
        calls.pendingSet.push(rec);
        pending = rec;
      },
      clear: async () => {
        pending = null;
      },
      mergeSetup: async (_tid: string, patch: Record<string, unknown>) => {
        calls.mergeSetup.push(patch);
        const base = pending && pending.kind === "setup" ? pending : { kind: "setup" };
        pending = { ...base, ...patch, kind: "setup" };
        return pending;
      },
    },
    chat: {
      render: async (threadId: string, p: Presentation) => {
        calls.rendered.push({ threadId, type: p.type });
      },
      subscribe: async (threadId: string) => {
        calls.subscribed.push(threadId);
      },
      capabilities: () => ({ imageDelivery: "upload" as const }),
    },
    isApprover: () => true,
    // 아래 표면은 이 테스트 경로에선 안 불리지만(설정/승인 경로만) 형태를 갖춰둔다.
    readNext: async () => {
      throw new Error("no next-action(테스트 경로 미사용)");
    },
    nl: { parse: async () => ({ kind: "unknown" as const, files: [] as string[] }) },
    bundleDir: () => undefined,
    stagedWbPath: () => undefined,
  } as unknown as Gateway;
  return { gw, calls };
}

/** author/텍스트/멘션여부를 갖춘 최소 Message(핸들러가 읽는 필드만). */
function msg(over: {
  threadId?: string;
  userId?: string;
  isMe?: boolean;
  isBot?: boolean;
  text?: string;
  isMention?: boolean;
}): Message {
  return {
    threadId: over.threadId ?? "t1",
    author: { userId: over.userId ?? "U-human", isMe: over.isMe ?? false, isBot: over.isBot ?? false },
    text: over.text ?? "",
    isMention: over.isMention ?? false,
    formatted: undefined,
    attachments: [],
  } as unknown as Message;
}

describe("wireInteractionHandlers(인터랙션 배선 · S-7)", () => {
  it("4개 핸들러(DM/멘션/버튼/답글)를 모두 등록한다(추출 전 createBot 과 동일 순서)", () => {
    const { chat, h, order } = makeFakeChat();
    const { gw } = makeRecordingGw();

    wireInteractionHandlers(chat, gw);

    expect(h.dm).toBeTypeOf("function");
    expect(h.mention).toBeTypeOf("function");
    expect(h.action).toBeTypeOf("function");
    expect(h.subscribed).toBeTypeOf("function");
    // 등록 순서 = createBot 인라인 블록과 동일(DM→멘션→버튼→답글).
    expect(order).toEqual(["dm", "mention", "action", "subscribed"]);
  });

  it("onDirectMessage → DM 안내 문구를 스레드에 그대로 게시(문구 바이트 동일 · 상태/잡 0)", async () => {
    const { chat, h } = makeFakeChat();
    const { gw, calls } = makeRecordingGw();
    wireInteractionHandlers(chat, gw);

    const posts: unknown[] = [];
    const thread = { post: async (m: unknown) => void posts.push(m) } as unknown as Thread;
    await h.dm!(thread, msg({}), {} as never);

    expect(posts).toEqual(["여기(DM)에서는 진행할 수 없어요 — 작업 채널에서 저를 멘션해 주세요."]);
    // DM 은 게이트웨이를 건드리지 않는다(안내만).
    expect(calls.submitted).toHaveLength(0);
    expect(calls.rendered).toHaveLength(0);
  });

  it("onAction(버튼) → 중립 ButtonPressed 로 번역해 onAction 위임 → 승인 잡 적재(queue.submit)", async () => {
    const { chat, h } = makeFakeChat();
    const { gw, calls } = makeRecordingGw();
    wireInteractionHandlers(chat, gw);

    // 일반 버튼: value=JSON{run_id, action:approve}(RA 불요) → 커널 onAction 이 approve 잡을 만든다.
    const event = {
      actionId: "gate:approve",
      value: JSON.stringify({ run_id: "chat-t1", action: "approve" }),
      user: { userId: "U-human" },
      threadId: "t1",
    } as unknown as ActionEvent;
    await h.action!(event);

    expect(calls.submitted).toHaveLength(1);
    expect(calls.submitted[0]!.kind).toBe("approve");
    expect(calls.submitted[0]!.run_id).toBe("chat-t1");
    // 감사 actor 는 어댑터가 Slack user 로 정규화(chat:slack:<user>) — 지어낸 값 아님.
    expect(calls.submitted[0]!.actor).toBe("chat:slack:U-human");
  });

  it("onSubscribedMessage: 봇 자신 메시지는 무시(게이트웨이 미접촉)", async () => {
    const { chat, h } = makeFakeChat();
    const { gw, calls } = makeRecordingGw({ pending: { kind: "setup" } });
    wireInteractionHandlers(chat, gw);

    await h.subscribed!({} as never, msg({ isMe: true, text: "봇이 올린 카드", isMention: false }));

    // isMe 조기 반환 — 어떤 위임도 없어야 한다.
    expect(calls.submitted).toHaveLength(0);
    expect(calls.rendered).toHaveLength(0);
    expect(calls.mergeSetup).toHaveLength(0);
    expect(calls.runForThreadCount).toBe(0);
  });

  it("onSubscribedMessage: 대기(pending) 있으면 멘션이어도 답글 소비 우선(멘션 재진입 아님)", async () => {
    const { chat, h } = makeFakeChat();
    // 설정 수집 대기 중 + isMention 인 답글 → onReply(setup 경로: 답=제품명)로 가야 한다(onMention 재진입 금지).
    const { gw, calls } = makeRecordingGw({ pending: { kind: "setup" } });
    wireInteractionHandlers(chat, gw);

    await h.subscribed!({} as never, msg({ text: "이지듀 쿠션", isMention: true }));

    // 답글 소비 경로 신호: mergeSetup(제품명 병합) 발생 · 재게시.
    expect(calls.mergeSetup).toEqual([{ product: "이지듀 쿠션" }]);
    expect(calls.rendered.map((r) => r.type)).toContain("Setup");
    // 멘션 재진입 경로였다면 chat.subscribe 가 불렸을 것 — 안 불렸어야 한다(대기 우선 규약).
    expect(calls.subscribed).toHaveLength(0);
  });

  it("onSubscribedMessage: 대기 없고 멘션이면 멘션 재진입(구독 + 설정 카드)", async () => {
    const { chat, h } = makeFakeChat();
    // pending=null·기존 run 없음 → onMention 폴백(빈 설정): pending=setup·subscribe·setup 카드.
    const { gw, calls } = makeRecordingGw({ pending: null, runForThread: null });
    wireInteractionHandlers(chat, gw);

    await h.subscribed!({} as never, msg({ text: "", isMention: true }));

    // 멘션 경로 신호: 구독 + 설정 카드. 답글 소비(mergeSetup)는 없어야 한다.
    expect(calls.subscribed).toEqual(["t1"]);
    expect(calls.rendered.map((r) => r.type)).toContain("Setup");
    expect(calls.mergeSetup).toHaveLength(0);
  });

  it("onNewMention → 새 스레드 멘션이 onMention 으로 위임(구독 + 빈 설정 카드)", async () => {
    const { chat, h } = makeFakeChat();
    const { gw, calls } = makeRecordingGw({ runForThread: null });
    wireInteractionHandlers(chat, gw);

    await h.mention!({} as never, msg({ text: "" }));

    expect(calls.subscribed).toEqual(["t1"]);
    expect(calls.rendered.map((r) => r.type)).toContain("Setup");
  });

  // ── threadScope(라이브 전용 · 수정 1) — 스코프 밖 스레드 이벤트는 gw 에 미위임, 같은 스레드만 위임 ──
  //   라이브 리허설은 단일 스레드 전용이라, 스코프를 주면 다른 스레드(남의 런)의 멘션/버튼/답글이 게이트웨이·
  //   드라이버 뷰를 오염시키지 못하게 조용히 무시된다(교차-스레드 상태 변이 차단). createBot 경로(스코프 미지정)는
  //   위 7개 테스트가 전-스레드 배선 불변임을 이미 못 박는다.
  it("threadScope 지정 → 다른 threadId 버튼은 gw 에 미위임 · 같은 스레드는 위임", async () => {
    const { chat, h } = makeFakeChat();
    const { gw, calls } = makeRecordingGw();
    wireInteractionHandlers(chat, gw, { threadScope: "t1" });

    // 스코프 밖 스레드(t-other) 버튼 → 조용히 무시(잡 적재 0).
    await h.action!({
      actionId: "gate:approve",
      value: JSON.stringify({ run_id: "chat-tX", action: "approve" }),
      user: { userId: "U-human" },
      threadId: "t-other",
    } as unknown as ActionEvent);
    expect(calls.submitted).toHaveLength(0);

    // 같은 스레드(t1) 버튼 → 위임(approve 잡 적재).
    await h.action!({
      actionId: "gate:approve",
      value: JSON.stringify({ run_id: "chat-t1", action: "approve" }),
      user: { userId: "U-human" },
      threadId: "t1",
    } as unknown as ActionEvent);
    expect(calls.submitted).toHaveLength(1);
    expect(calls.submitted[0]!.run_id).toBe("chat-t1");
  });

  it("threadScope 지정 → 다른 threadId 멘션은 gw 에 미위임 · 같은 스레드는 위임", async () => {
    const { chat, h } = makeFakeChat();
    const { gw, calls } = makeRecordingGw({ runForThread: null });
    wireInteractionHandlers(chat, gw, { threadScope: "t1" });

    // 스코프 밖 멘션 → 무시(구독·렌더 0).
    await h.mention!({} as never, msg({ threadId: "t-other", text: "" }));
    expect(calls.subscribed).toHaveLength(0);
    expect(calls.rendered).toHaveLength(0);

    // 같은 스레드 멘션 → 위임(구독 + 설정 카드).
    await h.mention!({} as never, msg({ threadId: "t1", text: "" }));
    expect(calls.subscribed).toEqual(["t1"]);
    expect(calls.rendered.map((r) => r.type)).toContain("Setup");
  });

  it("threadScope 지정 → 다른 threadId 답글은 gw 에 미위임 · 같은 스레드는 위임", async () => {
    const { chat, h } = makeFakeChat();
    const { gw, calls } = makeRecordingGw({ pending: { kind: "setup" } });
    wireInteractionHandlers(chat, gw, { threadScope: "t1" });

    // 스코프 밖 답글(제품명) → 무시(제품명 병합·재게시 0).
    await h.subscribed!({} as never, msg({ threadId: "t-other", text: "남의 제품", isMention: true }));
    expect(calls.mergeSetup).toHaveLength(0);
    expect(calls.rendered).toHaveLength(0);

    // 같은 스레드 답글 → 위임(제품명 병합 = 답글 소비 경로).
    await h.subscribed!({} as never, msg({ threadId: "t1", text: "이지듀 쿠션", isMention: true }));
    expect(calls.mergeSetup).toEqual([{ product: "이지듀 쿠션" }]);
  });

  it("★ 채널형 스코프(slack:C…) → 자식 합성 id(slack:C…:<ts>) 클릭은 스코프 안(논리 접두) · 콜론 경계라 다른 채널 오매치 없음", async () => {
    // Slack 은 채널형 스레드에 게시된 카드의 버튼 액션을 자식 합성 id(slack:C…:<message_ts>)로 실어 보낸다 —
    //   엄격 일치는 그 실 사람 클릭을 전부 조용히 버려 개입 경로가 무음 차단된다(Codex W2R2 P1). 논리 접두 판정 잠금.
    const { chat, h } = makeFakeChat();
    const { gw, calls } = makeRecordingGw();
    wireInteractionHandlers(chat, gw, { threadScope: "slack:C1" });

    // 자식 합성 id(카드별 message_ts) 클릭 → 스코프 안(위임).
    await h.action!({
      actionId: "gate:approve",
      value: JSON.stringify({ run_id: "chat-slack-C1", action: "approve" }),
      user: { userId: "U-human" },
      threadId: "slack:C1:1712345.678",
    } as unknown as ActionEvent);
    expect(calls.submitted).toHaveLength(1);

    // 콜론 경계 — 접두가 겹치는 다른 채널(slack:C12…)은 스코프 밖(오매치 금지).
    await h.action!({
      actionId: "gate:approve",
      value: JSON.stringify({ run_id: "chat-slack-C12", action: "approve" }),
      user: { userId: "U-human" },
      threadId: "slack:C12:1712345.678",
    } as unknown as ActionEvent);
    expect(calls.submitted).toHaveLength(1); // 여전히 1건 — C12 는 미위임
  });
});

// ── 이미지 다안 업로드 post 구조(P2 · 라이브 실측 회귀) ──────────────────────────
//   buildSlackChatPort 의 ImageOptionSet 렌더가 만드는 post 를 **구조적 fake**(실 Slack 0회)로 잠근다:
//   ① 안별 업로드 post({markdown: 캡션, files})가 카드보다 먼저 · ② 이미지 없는 안은 업로드 post 없음 ·
//   ③ 업로드 실패는 흐름을 막지 않고(카드는 그대로 게시) stderr 감사 1줄 · ④ 게시되는 모든 카드 title ≤150자
//   (Slack header 블록 하드리밋 — 151자 이상이면 post 전체 거부 = 2026-07 데모 라이브에서 카드 소실).
describe("buildSlackChatPort: ImageOptionSet 업로드 post 구조(구조적 fake · 실 Slack 0회)", () => {
  let dir: string;
  let pngA: string;
  let pngB: string;
  const bytesA = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]); // PNG 시그니처 흉내(내용은 무관)
  const bytesB = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 8, 7]);

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "kv-upload-"));
    pngA = join(dir, "full-a.png");
    pngB = join(dir, "full-b.png");
    await writeFile(pngA, bytesA);
    await writeFile(pngB, bytesB);
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** 게시만 기록하는 fake Chat — 옵션에 따라 files 실은 post(업로드)만 실패시킨다(missing_scope 재현). */
  function makePostingChat(opts?: { failUploads?: boolean }): {
    chat: Chat;
    posts: { threadId: string; message: Record<string, unknown> }[];
  } {
    const posts: { threadId: string; message: Record<string, unknown> }[] = [];
    const chat = {
      thread: (threadId: string) => ({
        post: async (message: unknown) => {
          const m = message as Record<string, unknown>;
          if (opts?.failUploads && Array.isArray(m.files)) {
            throw new Error("An API error occurred: missing_scope"); // 라이브 실측 원인 재현(토큰 무관 문자열)
          }
          posts.push({ threadId, message: m });
        },
        subscribe: async () => {},
      }),
    } as unknown as Chat;
    return { chat, posts };
  }

  function imageP(): ImageOptionSetPresentation {
    return {
      type: "ImageOptionSet",
      rid: "run-kv",
      header: "대표 이미지 시안",
      phase: "04-keyvisual",
      iteration: 1,
      options: [
        { key: "A", imagePaths: [pngA], caption: "A안 · 이미지 1장", recommended: true },
        { key: "B", imagePaths: [pngB], caption: "B안 · 이미지 1장", recommended: false },
        { key: "C", imagePaths: [], caption: "C안 · 미리보기 없음(디자인만 준비됨)", recommended: false },
      ],
      reviseAvailable: true,
    };
  }

  it("안별 업로드 post({markdown: 캡션, files:[Buffer]})가 카드보다 먼저 · 이미지 없는 안은 업로드 없음", async () => {
    const { chat, posts } = makePostingChat();
    await buildSlackChatPort(chat).render("slack:C1:1.2", imageP());

    // 업로드 post = files 실린 것. A·B 만(2건) — C 는 이미지 없음.
    const uploads = posts.filter((p) => Array.isArray(p.message.files));
    expect(uploads).toHaveLength(2);
    // 카드(안 3 + 트레일링 1 = 4장)는 업로드 **뒤에** 게시된다(미리보기 먼저 규약).
    expect(posts.slice(0, 2)).toEqual(uploads);
    expect(posts).toHaveLength(6);

    // 업로드 내용: 캡션 markdown + 검증된 경로의 실제 바이트 + 파일명(basename).
    expect(uploads[0]!.message.markdown).toBe("A안 · 이미지 1장");
    const filesA = uploads[0]!.message.files as { data: Buffer; filename: string }[];
    expect(filesA).toHaveLength(1);
    expect(Buffer.compare(filesA[0]!.data, bytesA)).toBe(0);
    expect(filesA[0]!.filename).toBe("full-a.png");
    expect((uploads[1]!.message.files as { filename: string }[])[0]!.filename).toBe("full-b.png");
  });

  it("업로드 실패(missing_scope 재현)여도 render 는 성공하고 카드 4장은 그대로 게시 + stderr 감사 1줄", async () => {
    const { chat, posts } = makePostingChat({ failUploads: true });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let lines: string[];
    try {
      await expect(buildSlackChatPort(chat).render("slack:C1:1.2", imageP())).resolves.toBeUndefined();
      lines = stderrSpy.mock.calls.map((c) => String(c[0])); // ⚠ mockRestore 가 호출 기록도 지우므로 복원 전에 스냅샷
    } finally {
      stderrSpy.mockRestore();
    }
    // 카드는 전부 게시(업로드 best-effort — 선택 흐름 불변).
    expect(posts).toHaveLength(4);
    expect(posts.every((p) => !Array.isArray(p.message.files))).toBe(true);
    // 감사 1줄(안별) — 무음 소실 금지(라이브에서 "첨부 0개 · 로그 무흔적" 진단 불가 회귀).
    expect(lines.filter((l) => l.includes("[slack-upload]") && l.includes("업로드 실패"))).toHaveLength(2);
  });

  it("게시되는 모든 카드 title 은 150자 이하(Slack header 하드리밋 — post 통째 거부 방지)", async () => {
    const { chat, posts } = makePostingChat();
    const p = imageP();
    p.header = "라벨 ".repeat(60); // 180자 — passthrough 라도 clamp 로 살아남아야 한다
    await buildSlackChatPort(chat).render("slack:C1:1.2", p);
    const cards = posts.filter((x) => !Array.isArray(x.message.files));
    expect(cards.length).toBeGreaterThan(0);
    for (const c of cards) {
      const title = (c.message as { title?: string }).title ?? "";
      expect(Array.from(title).length).toBeLessThanOrEqual(150);
    }
  });
});
