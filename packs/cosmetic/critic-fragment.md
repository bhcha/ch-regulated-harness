# 화장품 심의 4축 판정 예시 (critic-fragment)

> 도메인 팩 소유의 **심의 예시 조각(참조·설계용)**. core 프롬프트(`prompts/kcia-critic.md`)는 도메인 어휘를 담지 않고, 실제 판정 축·금지어는 `packs/cosmetic/ruleset.json` 의 `axes` 를 따른다. 아래는 화장품 기준의 대표 예시다.
>
> ⚠️ **이 조각은 원격 ADK 심의 지시문에 배선되지 않는다(의도).** ADK 지시문은 `adk_critic.py` 의 `_build_pass*_instruction` 이 **ruleset 단일 출처**(`_valid_axes`·`_ruleset_grounding` = axes 의 banned/triggers)로만 조립하며, 순수 함수가 HARNESS_ROOT·레지스트리·파일 I/O 와 의도적으로 격리돼 있다(단일 출처·깨끗한 격리). 아래 예시는 ruleset 의 banned/triggers 와 **내용이 중복**이라 배선해도 새 정보가 없고, 배선은 중복 텍스트를 위해 그 격리를 깨는 후퇴다. 따라서 kcia-critic.md·이 조각은 **사람이 읽는 참조/설계 문서**로 유지하고 배선하지 않는다(2부 5단계-B 결정).

1. **의약품 오인**(질병·약리·치료·재생·항염) → high, 무조건 revise.
2. **기능성 오인**(미백/주름/자외선) → 해당 기능성이 `approved` 가 아니면 효능 표현 high revise.
3. **소비자 기만/절대표현**(최초/1위/무결점/즉시/피부나이/줄기세포 등) → high.
4. **실증 필요**(안티에이징/콜라겐/수분 N%/피부과 테스트 등) → SCI·전문학회지·인체적용/외시험 근거 없으면 다운그레이드.
