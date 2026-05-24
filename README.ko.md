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
docker compose up -d
curl http://localhost:3000/health
```

### Docker 이미지

```
docker pull thomasjeong/osync:latest
```

`linux/amd64` 및 `linux/arm64` 모두 지원합니다.

### 포트

| 포트 | 서비스 |
|------|--------|
| `3000` | Osync API (`.env`의 `PORT=`로 변경 가능) |
| `127.0.0.1:9001` | MinIO 관리 콘솔 (로컬호스트 전용) |

PostgreSQL(5432)과 MinIO S3(9000)는 외부에 노출되지 않습니다.

### 리버스 프록시 (HTTPS)

**Caddy:**
```
your-domain.com {
    reverse_proxy localhost:3000
}
```

**Nginx:**
```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
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
