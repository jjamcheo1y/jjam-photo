# 대짬철갤러리

폰 사진 폴더를 Eagle 처럼 정리하는 안드로이드 앱. 폰 저장소의 실제 폴더 구조를 그대로 따라가요.

- 화면: `www/` (HTML/CSS/JS, 빌드 없음). 브라우저에서 `www/index.html` 을 열면 가짜 파일(`mock.js`)로 화면만 확인 가능.
- 폰 파일 처리: `android/app/src/main/java/com/jjam/photo/PhotoFsPlugin.java` (모든 파일 접근 권한 사용)
- 휴지통: 저장소 안 `.jjamtrash/` (30일 뒤 자동 삭제)
- 설치: GitHub `Releases > latest` 의 APK 를 폰에서 받아 설치(기존 앱 위에 덮어 설치됨, 서명 키 고정).
