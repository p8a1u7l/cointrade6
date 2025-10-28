# 제니스 트레이더 스위트

제니스 트레이더 스위트는 Webull 스타일의 암호화폐 선물 트레이딩 제어실을 구현한 엔드 투 엔드 샘플 스택입니다. 구성 요소는 다음과 같습니다.

- **오케스트레이터 API** (Node.js + TypeScript): 바이낸스 선물과 통신하고 GPT-5 Pro 전략 호출을 조율하며, 인메모리 분석 스토어에 테레메트리를 기록합니다. 합성 데이터 폴백 없이 실제 API 응답만을 사용합니다.
- **헬리오스 대시보드** (Vite + React + TypeScript): 실시간 성과 지표, 리스크 설정, 거래 내역을 데스크톱 UI 형태로 스트리밍합니다.
- **아카이브 데이터 레이어** (NDJSON 파일): 인메모리 분석 스토어를 `backend/data/analytics-history.ndjson`으로 지속 기록해 외부 리포트나 백업에 활용할 수 있습니다.

> ⚠️ 제니스 트레이더 스위트는 교육용 예제로 설계되었습니다. 실제 API 키로 배포하기 전에는 반드시 자체적인 검증, 보안 점검, 모의 거래를 수행하세요.

## 빠른 시작

1. **인프라 준비**
   - 백엔드와 프런트엔드를 실행할 Node.js 환경만 있으면 됩니다.

2. **오케스트레이터 설정**
   ```bash
   cd zenith/backend
   cp .env.example .env
   npm run build
   npm run start
   ```
   저장소에는 바로 실행할 수 있도록 테스트넷 바이낸스 및 GPT-5 Pro 기본 키가 포함되어 있습니다. 실거래 키를 사용하려면 `.env`에서 값을 덮어쓰세요.

3. **대시보드 실행**
   ```bash
   cd zenith/frontend
   npm install
   npm run dev
   ```
   개발 서버를 시작하기 전에 `src/config.ts`에서 백엔드 기본 URL이 맞는지 확인하세요.

4. **시스템 운용**
   - 대시보드의 **공격성 다이얼(1-5)** 로 실시간 리스크 프리셋을 변경합니다.
   - **Start** 버튼으로 실행 루프를 시작하고 **Stop** 버튼으로 일시 중지합니다.
   - 인메모리 분석 스토어에서 제공하는 실시간 잔고, 누적 손익, 종목별 분석을 모니터링합니다.

## 저장소 구조

```
zenith/
├── backend/        # 자동매매 오케스트레이터 (Node.js HTTP)
│   └── data/       # 분석 기록을 저장하는 NDJSON 아카이브
└── frontend/       # Webull 영감을 받은 React 대시보드
```

각 서브 프로젝트에는 세부 설정을 설명하는 README가 포함되어 있습니다.

## 로컬 분석 아카이브

기존 Supabase 함수 대신, 오케스트레이터는 모든 지표와 체결 이벤트를 `backend/data/analytics-history.ndjson` 파일에 직렬화합니다. 파일은
자동으로 생성·갱신되며, `tail -f zenith/backend/data/analytics-history.ndjson` 명령으로 실시간 변화를 관찰할 수 있습니다. 동일한 데이터는
`GET /metrics/archive?limit=500` 엔드포인트를 통해서도 JSON 형태로 내려받을 수 있으므로, 외부 BI 도구나 추가 백테스트 파이프라인에서 손쉽게
소비할 수 있습니다.

## 패키징

저장소 루트에서 `make package`를 실행하면 전체 솔루션을 담은 `zenith-suite.zip`이 생성됩니다.
