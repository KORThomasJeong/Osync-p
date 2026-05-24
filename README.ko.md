# Osync

한국어 | **[English](README.md)**

<p align="center">
  <a href="https://www.buymeacoffee.com/thomasjeong" target="_blank">
    <img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" height="50">
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

### 어드민 UI

`http://localhost:3000/admin/` 에서 사용자, 초대코드, 볼트 통계를 관리할 수 있습니다.

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
