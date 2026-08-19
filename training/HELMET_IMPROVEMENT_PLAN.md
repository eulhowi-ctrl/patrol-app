# 헬멧(no_helmet) 인식률 개선 계획

> 다음 세션에서 이 파일을 읽고 이어서 작업할 것. 진행 상태는 하단 [진행 상태] 참고.

## 진단 결과 (2026-08-19)

- 조끼(no_vest)는 잘 감지되는데 헬멧(no_helmet)은 거의 감지 안 됨.
- `training/merge_datasets.py`의 클래스 리맵 코드는 **정상 확인됨** (버그 아님):
  - HB1204/PPE_Detection의 실제 `data.yaml` 기준 인덱스 6=NO-Hardhat, 7=NO-Safety Vest, 5=NO-Goggles.
  - 코드의 `remap = {6: NO_HELMET, 7: NO_VEST, 5: NO_GLASSES}`와 정확히 일치.
- 원인은 **클래스 불균형 + 낮은 해상도/학습량**으로 추정:
  - Roboflow 계열 PPE 데이터셋은 원래 "안전모 미착용" 샘플 수가 "조끼 미착용"보다 훨씬 적음.
  - 기존 학습 설정(`train.py`)이 `imgsz=256`, `epochs=20`으로 작고 짧음 — 어려운 클래스에 불리.

## 선택한 개선 방향: 데이터 보강 + 재학습

빠른 임계값 조정이 아니라 **근본적으로 데이터를 보강하고 재학습**하기로 결정함.

### 추가할 데이터셋 후보 (조사 완료)

1. **njvisionpower/Safety-Helmet-Wearing-Dataset (SHWD)** — 최우선 추천
   - GitHub: https://github.com/njvisionpower/Safety-Helmet-Wearing-Dataset
   - 7,581장, "hat"(착용) 9,044개 + "person"(미착용 맨머리) **111,514개**
   - 미착용 샘플이 압도적으로 많아 클래스 불균형 문제를 직접 해결해줌
   - 라이선스: MIT (사용 제약 없음)
   - 포맷: Pascal VOC XML (Annotations/ImageSets/JPEGImages 폴더 구조)

2. **Voxel51/hard-hat-detection** — 보조 후보
   - HuggingFace: https://huggingface.co/datasets/Voxel51/hard-hat-detection
   - 5,000장, 클래스: Helmet / Person / Head("Head"=맨머리=미착용에 대응)
   - 라이선스: CC0-1.0 (완전 자유 이용)
   - 포맷: Pascal VOC XML

두 데이터셋 모두 Pascal VOC XML 형식이라, `merge_datasets.py`의 `convert_mask()` 함수(현재 face-mask-detection에 쓰는 XML 파싱 로직)와 **동일한 패턴을 재사용**해서 변환기를 작성하면 됨.

### 구체적 실행 단계

1. `training/raw_datasets/`에 위 두 데이터셋 다운로드 (huggingface_hub 또는 git clone)
2. `merge_datasets.py`에 `convert_shwd()`, `convert_hardhat()` 함수 추가
   - "hat"/"Helmet" 클래스는 무시(우리는 미착용만 탐지)
   - "person"(SHWD)/"Head"(Voxel51)를 `NO_HELMET`(인덱스 0)으로 매핑
   - 기존 `convert_mask()`의 XML 파싱 코드 그대로 참고
3. 기존 HB1204/PPE_Detection의 NO-Hardhat 샘플과 합쳐서 `merged_yolo/` 재생성
4. `train.py` 학습 설정 상향 조정:
   - `imgsz`: 256 → 384
   - `epochs`: 20 → 40 (patience=15 유지, 조기 종료 가능)
5. CPU 전용 환경이라 학습에 1~3시간 소요 예상 — 백그라운드 실행 권장
6. 학습 완료 후 `best.pt` → ONNX export, `web/public/models/detector.onnx` 교체
7. `npm run build` + `npm test`로 회귀 확인 후 커밋/푸시

### 환경 확인 완료 (2026-08-19)

- Python 3.11.9, ultralytics 8.4.121, torch 2.13.0+cpu(GPU 없음), huggingface_hub 설치 확인됨.
- `training/raw_datasets/`는 `.gitignore` 처리되어 있어 현재 비어 있음 — 재다운로드 필요.

## 진행 상태

- [x] 원인 진단 (클래스 불균형 추정)
- [x] 보강 데이터셋 조사 (SHWD, Voxel51 hard-hat-detection)
- [ ] 데이터셋 다운로드
- [ ] `merge_datasets.py`에 변환 함수 추가
- [ ] 재학습 실행
- [ ] ONNX export 및 앱 반영
- [ ] 빌드/테스트 통과 확인 후 커밋·푸시
