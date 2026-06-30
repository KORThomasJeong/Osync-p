# Osync

한국어 | **[English](README.md)**

<p align="center">
  <a href="https://ko-fi.com/thomasjeong" target="_blank">
    <img src="https://storage.ko-fi.com/cdn/kofi3.png?v=3" alt="Buy Me a Coffee at ko-fi.com" height="50">
  </a>
</p>

Obsidian 볼트를 E2EE(종단간 암호화)로 동기화하는 플러그인.

## 개요

Osync는 모바일을 포함한 모든 기기에서 Obsidian 볼트를 동기화합니다. 노트는 기기를 떠나기 전에 로컬에서 암호화되어, 서버는 내용을 볼 수 없습니다.

## 주요 기능

### 종단간 암호화 (E2EE)

- 전송 전 로컬에서 AES-256-GCM 암호화 적용
- Argon2id로 비밀번호에서 볼트 키 파생
- 비밀번호 변경 시 데이터 노출 없이 재암호화
- 서버는 암호화된 블롭만 저장 — 서버 운영자도 내용을 볼 수 없음

### 실시간 동기화

- Obsidian을 열거나 포커스가 돌아올 때 자동 동기화
- 상태 표시줄에서 현재 동기화 상태 실시간 확인
- 설정 화면에서 동기화 진행률 표시
- 동기화 일시 중지 / 재개 가능

### 기기별 세부 설정

각 기기마다 별도로 설정 가능:

- 이미지, 오디오, 동영상, PDF, 기타 첨부파일 동기화 개별 on/off
- Obsidian 설정 폴더 동기화 on/off
- 기기별 동기화 제외 폴더 지정

### 볼트 관리

- 새 원격 볼트 생성 또는 기존 볼트 연결
- 데이터 삭제 없이 볼트 연결 해제
- 삭제된 파일 목록 확인 및 복원
- 파일별 버전 히스토리 열람
- 여러 기기에서 동시 편집 시 충돌 해결 패널

### 커맨드 팔레트 명령어

| 명령어 | 설명 |
|--------|------|
| Sign in / Sign out | 이 기기 인증 |
| Create remote vault | 서버에 새 암호화 볼트 생성 |
| Connect to remote vault | 기존 원격 볼트에 연결 |
| Disconnect vault | 원격 볼트 연결 해제 |
| Change vault password | 새 비밀번호로 볼트 키 재암호화 |
| View version history | 파일의 이전 버전 열람 |
| Toggle sync pause | 동기화 일시 중지 / 재개 |
| Reset local sync state | 서버에서 전체 재동기화 강제 실행 |

## 설치

### 커뮤니티 플러그인 (권장)

1. Obsidian → **설정** → **커뮤니티 플러그인**
2. **Osync** 검색
3. 설치 후 활성화

### 수동 설치

최신 릴리즈에서 파일을 다운로드해 볼트의 `.obsidian/plugins/osync/` 폴더에 넣기:

- `main.js`
- `manifest.json`
- `styles.css`

이후 **설정** → **커뮤니티 플러그인**에서 활성화.

## 초기 설정

1. **설정** → **Osync** 열기
2. 서버 URL 입력
3. 로그인 또는 계정 생성
4. 새 볼트 생성 또는 기존 볼트 연결
5. 볼트 비밀번호 설정 — 이 비밀번호가 암호화의 핵심

> **주의:** 볼트 비밀번호는 서버에서 복구할 수 없습니다. 반드시 안전하게 보관하세요.

## 셀프호스팅

Osync는 완전히 셀프호스팅이 가능합니다. 서버는 Docker 이미지로 배포되며 소스코드 없이 바로 실행할 수 있습니다.

**요구사항:** Docker, Docker Compose, `openssl`

### 빠른 시작

```bash
curl -fsSL https://raw.githubusercontent.com/KORThomasJeong/Osync-p/main/install.sh | bash
```

스크립트가 `docker-compose.yml`을 받고, 무작위 시크릿이 채워진 `.env`를 새로 만들고, 스택을 띄운 뒤 자동 생성된 어드민 이메일/비밀번호를 출력합니다. **비밀번호는 단 한 번만 표시되니 반드시 보관하세요.**

어드민 이메일이나 공개 URL을 미리 지정하고 싶다면:

```bash
ADMIN_EMAIL=me@example.com PUBLIC_URL=https://osync.example.com \
  bash -c "$(curl -fsSL https://raw.githubusercontent.com/KORThomasJeong/Osync-p/main/install.sh)"
```

스크립트는 재실행해도 안전합니다 — 기존 `.env`는 절대 덮어쓰지 않습니다. 첫 로그인 후에는 `.env`의 `ADMIN_EMAIL` / `ADMIN_PASSWORD`를 삭제하세요.

#### 첫 배포 가이드 (권장)

새로 2.1.7을 배포할 때 따라야 할 전체 순서:

1. **서브도메인 두 개 정하기.** 보유 중인 도메인 아래에 형제 관계인 서브도메인 두 개를 정합니다. 예:
   - `osync.your-domain.com` → API
   - `osync-s3.your-domain.com` → MinIO S3

   두 도메인은 같은 깊이에 두세요. Cloudflare 무료 Universal SSL이 `*.your-domain.com`을 자동으로 커버하므로 인증서가 별도 작업 없이 발급됩니다. `s3.osync.your-domain.com`처럼 더 깊은 이름은 유료 와일드카드가 없는 한 피하세요.

2. **DNS 설정.** 각 서브도메인을 서버 IP로 가리키는 A/AAAA 레코드(또는 CNAME)를 추가합니다. Cloudflare를 쓴다면 프록시(주황 구름)는 켜둔 채로 두세요 — 엣지에서 TLS까지 처리됩니다.

3. **리버스 프록시 설정** (예: Nginx Proxy Manager):
   - 프록시 호스트 1 생성: `osync.your-domain.com` → `osync-api:3000` (네트워크 구성에 따라 `localhost:3000`). Advanced 탭에 아래 "리버스 프록시 (HTTPS)" 섹션의 API용 nginx 스니펫을 붙여넣고, SSL은 Let's Encrypt 또는 기존 인증서로 활성화하세요.
   - 프록시 호스트 2 생성: `osync-s3.your-domain.com` → `minio:9000` (또는 `localhost:9000`). Advanced 탭에 MinIO용 nginx 스니펫을 붙여넣고 SSL을 활성화하세요.
   - 두 호스트 모두 버퍼링 OFF, 본문 크기 제한 해제는 필수입니다 (다음 섹션 스니펫 참조).

4. **`.env` 구성.** 예시 파일을 `curl`로 받거나 설치 스크립트 실행 후 `.env`를 편집합니다:
   ```
   PUBLIC_URL=https://osync.your-domain.com
   CORS_ORIGIN=https://osync.your-domain.com
   S3_PUBLIC_ENDPOINT=https://osync-s3.your-domain.com
   MINIO_PUBLIC_URL=https://osync-s3.your-domain.com
   ```
   `S3_PUBLIC_ENDPOINT`는 API 서버가 presigned URL에 서명할 때 사용하는 값입니다. `MINIO_PUBLIC_URL`은 MinIO 컨테이너의 `MINIO_SERVER_URL`로 전달되어 MinIO 자체의 리다이렉트/콘솔이 매칭되도록 합니다. 두 값은 동일해야 합니다.

5. **스택 기동:**
   ```bash
   docker compose pull
   docker compose up -d
   docker compose logs -f api
   ```
   로그에 `[i18n] language=...` 와 `[osync] API running on http://localhost:3000` 가 보이면 정상입니다. postgres와 MinIO 헬스체크가 끝날 때까지 잠시 기다리세요.

6. **스모크 테스트:**
   ```bash
   # 도메인을 통해 API 접근 확인
   curl -fsSI https://osync.your-domain.com/health

   # MinIO 서브도메인 접근 확인 (XML 403이 떠야 정상 — 프록시 + TLS가 동작한다는 뜻)
   curl -fsSI https://osync-s3.your-domain.com/
   ```
   둘 중 하나라도 실패하면 다음 단계로 넘어가지 말고 리버스 프록시부터 고치세요.

7. **첫 로그인.** 초기 어드민 이메일/비밀번호는 설치 스크립트 출력에 표시되었습니다 (비밀번호는 단 한 번만 표시됩니다 — 잃어버렸다면 `.env`에 `ADMIN_PASSWORD`를 다시 설정하고 한 번 재시작하세요). `https://osync.your-domain.com/admin/` 에서 로그인 후 초대코드를 만들고, `https://osync.your-domain.com/signup/` 에서 가입하세요.

8. **플러그인 설치.** Obsidian → 설정 → 커뮤니티 플러그인 → **Osync** 검색 → 설치 + 활성화. 플러그인 설정에서 서버 URL을 `https://osync.your-domain.com` 으로 지정하고 로그인한 뒤 볼트를 생성하거나 연결하세요.

#### 수동 설치

bash로 파이프해서 실행하기 싫다면:

```bash
curl -O https://raw.githubusercontent.com/KORThomasJeong/Osync-p/main/docker-compose.yml
curl -O https://raw.githubusercontent.com/KORThomasJeong/Osync-p/main/.env.example
cp .env.example .env
# .env 편집 — CHANGE_ME 항목 교체 + 시크릿 생성:
#   BETTER_AUTH_SECRET=$(openssl rand -hex 32)
#   SYNC_TOKEN_SECRET=$(openssl rand -hex 32)
#   MINIO_KMS_SECRET_KEY=osync-key:$(openssl rand -base64 32)
# MinIO presigned URL용 공개 주소도 함께 설정:
#   MINIO_PUBLIC_URL=https://osync-s3.example.com
docker compose up -d
curl http://localhost:3000/health
```

> 2.1.7부터 서버는 presigned URL을 발급하고, 플러그인은 암호화된 블롭을 **MinIO에 직접** 업/다운로드합니다 (API 서버를 거치지 않음). 따라서 `.env`에 `MINIO_PUBLIC_URL=https://osync-s3.example.com` 같은 공개 URL을 반드시 지정해야 하며, `docker-compose.yml`은 이 값을 MinIO 컨테이너의 `MINIO_SERVER_URL`로 전달합니다. 이 값이 실제 공개 호스트와 일치해야 presigned 서명이 맞습니다.

### Docker 이미지

```
docker pull thomasjeong/osync:latest
```

`linux/amd64` 및 `linux/arm64` 모두 지원합니다.

### 포트

| 포트 | 서비스 | 외부 노출 방식 |
|------|--------|----------------|
| `3000` | Osync API (`.env`의 `PORT=`로 변경 가능) | API용 서브도메인 리버스 프록시 (예: `osync.example.com`) |
| `9000` | MinIO S3 API | 전용 서브도메인 리버스 프록시 (예: `osync-s3.example.com`) |
| `127.0.0.1:9001` | MinIO 관리 콘솔 | 로컬호스트 전용 (변경 없음) |
| `5432` | PostgreSQL | 외부 노출 안 함 |

> 2.1.7부터는 플러그인이 presigned URL로 직접 MinIO에 접근해야 하므로 MinIO S3 API(`9000`)도 **반드시** 공개 서브도메인으로 노출해야 합니다. 단, 9000 포트 자체는 방화벽으로 막고 리버스 프록시 경로만 외부에 공개하세요.

### 리버스 프록시 (HTTPS)

Osync 2.1.7+는 블롭 전송에 **presigned URL** 방식을 사용합니다. API 서버는 짧게 유효한 서명된 URL만 발급하고, Obsidian 플러그인은 암호화된 바이트를 **MinIO에 직접** 업/다운로드합니다. API 서버는 블롭 본문을 전혀 중계하지 않습니다 — AWS S3 클라이언트와 동일한 구조이며, API 서버의 메모리 사용량이 크게 줄고 처리량이 올라갑니다.

따라서 리버스 프록시에 **서브도메인 두 개**를 설정해야 합니다:

| 서브도메인 | 업스트림 | 역할 |
|-----------|---------|------|
| `osync.example.com` | API 컨테이너 `:3000` | REST + WebSocket 코디네이터 |
| `osync-s3.example.com` | MinIO `:9000` | presigned 블롭 업/다운로드 |

**TLS / 와일드카드 인증서.** Cloudflare의 무료 Universal SSL은 1단계 와일드카드(`*.example.com`)를 커버하므로, `osync.example.com`과 `osync-s3.example.com`처럼 **형제 관계인** 서브도메인 두 개는 무료 인증서로 바로 사용할 수 있습니다. `*.osync.example.com` 같은 더 깊은 와일드카드는 Cloudflare Advanced Certificate Manager(유료) 또는 Let's Encrypt DNS-01 와일드카드가 필요하므로, 그냥 형제 서브도메인을 쓰는 게 편합니다.

**MinIO에 공개 URL을 알려줘야 합니다.** 위 `.env`의 `MINIO_PUBLIC_URL`을 통해 MinIO 컨테이너의 `MINIO_SERVER_URL`을 공개 URL(예: `https://osync-s3.example.com`)과 **정확히** 일치하게 설정하세요. 불일치하면 presigned 서명이 깨져 업로드가 `SignatureDoesNotMatch`로 실패합니다.

**프록시 버퍼링은 반드시 꺼야 합니다.** 암호화된 블롭은 크기가 클 수 있어, 프록시가 본문을 통째로 버퍼링하면 메모리를 잡아먹고 업로드가 멈춥니다. 두 vhost 모두 스트리밍 모드 + 본문 크기 제한 해제가 필요합니다.

**Caddy (권장 — 기본값이 합리적):**
```caddyfile
osync.example.com {
    reverse_proxy localhost:3000
    request_body {
        max_size 0
    }
}

osync-s3.example.com {
    reverse_proxy localhost:9000 {
        flush_interval -1
    }
    request_body {
        max_size 0
    }
}
```

**Nginx (또는 Nginx Proxy Manager의 Advanced 탭):**
```nginx
# osync.example.com (API + WebSocket)
location / {
    proxy_pass http://osync-api:3000;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "Upgrade";
    proxy_read_timeout 86400;
    client_max_body_size 0;
}

# osync-s3.example.com (MinIO presigned 블롭 전송)
location / {
    proxy_pass http://minio:9000;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_connect_timeout 300;
    proxy_send_timeout 300;
    proxy_read_timeout 300;
    client_max_body_size 0;
}
```

### 트러블슈팅

- **업/다운로드 시 `SignatureDoesNotMatch`** — `MINIO_PUBLIC_URL` 또는 `S3_PUBLIC_ENDPOINT`가 클라이언트가 실제로 접속하는 호스트와 정확히 일치하지 않거나, 리버스 프록시가 MinIO로 `Host $host`를 넘기지 않는 경우입니다. 두 환경변수가 `osync-s3.your-domain.com`의 공개 URL과 일치하는지, 그리고 MinIO Nginx 블록에 `proxy_set_header Host $host;`가 있는지 확인하세요.

- **`RequestTimeTooSkewed`** — 서버 시계 오차가 15분 이상입니다. `timedatectl set-ntp true` (또는 OS에 맞는 명령)로 해결하세요.

- **`osync-s3.*` 에서 502 Bad Gateway** — 프록시가 `minio:9000`을 resolve 하지 못한 경우입니다. Nginx가 MinIO와 다른 Docker 네트워크에 있다면 같은 네트워크에 합류시키거나, MinIO가 호스트에 바인딩되어 있다면 서비스 이름 대신 `localhost:9000`을 쓰세요.

- **업로드가 멈추거나 `413 Request Entity Too Large` 로 실패** — nginx가 본문을 버퍼링하고 크기를 제한하고 있습니다. **두 vhost 모두에** `proxy_request_buffering off`, `proxy_buffering off`, `client_max_body_size 0`이 들어가 있는지 확인하세요. Caddy라면 `request_body { max_size 0 }`이 있는지 확인.

- **모바일 앱이 백그라운드로 가면 동기화가 멈춤** — 정상 동작입니다. 모바일 OS는 WebView를 일시정지시키므로 WebSocket이 끊깁니다. Obsidian이 다시 보이면 동기화가 재개됩니다. 버그가 아닙니다.

- **업그레이드 직후 플러그인이 "json parse error" 표시** — API 컨테이너가 WebSocket 중간에 죽었을 가능성이 큽니다. `docker compose logs api`에서 스택 트레이스를 확인하세요. `meta/_journal.json`이 언급된다면 이미지가 `2.1.6+drizzle-do-fix`보다 오래된 것이니 `thomasjeong/osync:latest`를 pull한 뒤 재시작하세요.

- **서브도메인 없이 단일 머신에서 셀프호스팅하는 경우** — `S3_PUBLIC_ENDPOINT`와 `MINIO_PUBLIC_URL`을 **비워두면** 서버가 presigning용 주소로 `S3_ENDPOINT` (내부 MinIO URL)를 사용합니다. 이 경우 presigned URL은 `http://minio:9000`을 가리키게 되어 API 컨테이너 자신에게서만 접근 가능합니다. 결과적으로 같은 호스트에서 도는 클라이언트만 블롭 전송이 가능하니, 실제 배포에서는 반드시 서브도메인 구성을 사용하세요.

### 어드민 UI

첫 실행 시 생성된 어드민 계정으로 `http://localhost:3000/admin/` (또는 `https://osync.your-domain.com/admin/`)에 로그인하세요. 대시보드는 다음 패널로 구성됩니다:

| 패널 | 할 수 있는 일 |
|------|----------------|
| **사용자** | 모든 계정과 역할을 조회하고, 새 사용자(user/admin)를 생성하며, 비밀번호를 재설정하고, 사용자를 삭제합니다. 비밀번호 재설정·삭제 시 텔레그램 알림을 보낼 수 있습니다(설정 참고). |
| **초대 코드** | 가입용 초대 코드를 생성하고 사용량(`사용 / 최대`)을 추적하며, 각 코드를 취소·초기화·삭제합니다. 가입은 초대제이므로 새 사용자를 받으려면 여기서 코드를 발급합니다. |
| **볼트 통계** | 전체 요약(사용자 수, 파일 수, 사용 용량, 사용자당 평균 파일 수)과 함께, **MinIO에서 직접** 집계한(가장 정확한 출처) 사용자별 → 볼트별 용량 내역을 보여줍니다. 여기서 볼트의 삭제된 파일(tombstone)을 정리해 용량을 회수할 수도 있습니다. |
| **그룹** | 그룹을 생성하고 멤버를 추가·제거하며, 그룹 멤버 간에 볼트를 공유합니다. |
| **설정** | 텔레그램 알림 연동(봇 토큰 + 채팅 ID, 테스트 버튼 포함)을 구성하고, 어떤 이벤트에 알림을 보낼지 토글하며, 새 초대 코드의 기본 최대 사용 횟수를 설정합니다. |
| **알림 히스토리** | 최근에 발송된 알림 기록을 조회합니다. |

> **알림은 선택 사항입니다.** **설정**에서 텔레그램 봇을 구성하지 않으면 서버는 알림 발송을 그냥 건너뜁니다 — 나머지 어드민 기능은 모두 정상 동작합니다.

어드민 계정은 첫 실행 시 `ADMIN_EMAIL` / `ADMIN_PASSWORD`로부터 자동 생성됩니다(설치 스크립트가 생성된 비밀번호를 한 번만 출력). 첫 로그인 후에는 `.env`에서 해당 변수를 삭제하세요.

### 데이터 저장 위치

| 볼륨 | 내용 |
|------|------|
| `postgres_data` | 사용자 계정, 볼트 메타데이터 |
| `minio_data` | 암호화된 볼트 블롭 |
| `coordinator_data` | 실시간 동기화 상태 |

> 볼트 비밀번호는 서버에 저장되지 않습니다. 서버 운영자도 노트 내용을 볼 수 없습니다.

## 릴리즈

플러그인 릴리즈는 이 레포의 GitHub Releases에서 배포됩니다. 각 릴리즈에 포함된 파일:

- `main.js` — 컴파일된 플러그인
- `manifest.json` — 플러그인 메타데이터
- `styles.css` — 스타일
- `versions.json` — Obsidian 버전 호환성 맵

## 라이선스

MIT
