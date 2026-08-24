# 헬멧(no_helmet) 인식률 개선 계획 (+ 조끼 오탐 재확인 예정)

> 다음 세션에서 이 파일을 읽고 이어서 작업할 것. 진행 상태는 하단 [진행 상태] 참고.
> **2026-08-25 05:07 KST: 재학습 완료 및 앱 반영 완료(커밋됨, 푸시는 사용자 확인 대기).
> 남은 일은 실기기 재확인뿐 — 아래 [진행 상태] 참고.**
> **2026-08-21 추가**: 사용자가 실기기 테스트 중 "안전조끼 착용 중인데 no_vest로 오탐"을
> 보고함. 조사 결과 `PPE_Detection` 데이터셋 자체는 정상 착용(Safety Vest) 이미지가
> 위반(NO-Safety Vest) 이미지보다 오히려 2배 이상 많아(train 기준 1,793장 vs 831장)
> 라벨 불균형 문제로 보이진 않음 — 조끼 스타일/조명 도메인 차이 또는 현재 배포된 구모델
> (imgsz=256, 저에폭)의 전반적 정확도 부족 쪽에 무게를 둠. **사용자와 합의: 지금 도는
> 재학습(아래, 6클래스 전체 대상이라 조끼도 같이 개선될 수 있음)을 먼저 배포해서
> 재확인하고, 그래도 조끼 오탐이 남으면 그때 조끼 전용 데이터셋을 추가 조사·병합해서
> 다음 재학습에 반영**하기로 함. 지금은 조끼 데이터셋을 따로 찾지 않음.

## 진행 현황 (2026-08-20 업데이트)

- SHWD(njvisionpower)는 **실제로는 GitHub에 데이터가 없고**(데모 이미지 20장뿐, 진짜 데이터는
  Baidu/Google Drive 외부 링크라 다운로드 불가) 제외. 대신 **Voxel51/hard-hat-detection**만
  사용 — "head"(맨머리) 5,785개 라벨을 no_helmet으로 매핑, `merge_datasets.py`에
  `convert_hardhat()` 함수로 반영 완료.
- `merged_yolo/` 재생성 완료: no_helmet 1,100개 → **6,885개**로 증가 (6.3배).
- `train.py`: imgsz 256→384, epochs 20→40 반영 완료. 새 런은 `runs/patrol_detector_v2/`
  (기존 `patrol_detector/` 결과는 보존, 건드리지 않음).
- **학습 스케줄**: 한국시간(KST) **00:00~09:00에만** 진행, 09:00에 자동 정지 후 다음
  00:00에 `resume=True`로 이어서 진행 (`train_watchdog.sh`가 매 5분 시간 체크).
  09:00~24:00 사이엔 프로세스가 죽어있는 게 정상 동작임.
- **watchdog 구조**: `train_watchdog.sh`(nohup+disown으로 세션과 무관하게 상시 실행)가
  train.py를 감시 — 크래시/세션종료/스케줄 종료 등 어떤 이유로 죽어도 `last.pt`에서
  자동으로 이어서 재시작함. 로그: `training/train_watchdog.log`.
  완료되면 `runs/patrol_detector_v2/TRAINING_DONE` 마커 파일이 생김(아직 없음).
- 2026-08-20 16:11 KST 기준: **8/40 에폭 완료**, mAP50 0.29 → 0.45로 상승 중 (순조로움).
  에폭당 실제 연산 시간 약 76분, 하룻밤(9시간 창)에 약 7에폭씩 진행됨.

## 진단 결과 (2026-08-19)

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
- [x] 보강 데이터셋 조사 (SHWD → 실데이터 없어 제외, Voxel51 hard-hat-detection 채택)
- [x] 데이터셋 다운로드 (Voxel51, 5,006장)
- [x] `merge_datasets.py`에 `convert_hardhat()` 추가, `merged_yolo/` 재생성
- [x] `train.py` 하이퍼파라미터 상향 (imgsz 384, epochs 40)
- [x] **재학습 완료 (2026-08-25 05:07 KST) — 40/40 에폭, mAP50 0.29 → 0.676, mAP50-95 0.410**
- [x] ONNX export 및 앱 반영 (`web/public/models/detector.onnx` 교체,
      `detection.worker.ts`의 입력 크기를 `DETECTOR_INPUT_SIZE=384`로 분리 — person.onnx는
      별도 모델(imgsz=256)이라 안 건드림)
- [x] 빌드/테스트 통과 확인 후 커밋 (푸시는 사용자 확인 후 진행 예정)
- [ ] 실기기 재확인 — 헬멧 인식률 개선 체감 + [[안전조끼 오탐]]도 같이 개선됐는지 확인

## 다음 세션에서 할 일

1~5번(재학습 완료 확인 → ONNX export → 앱 반영 → 빌드/테스트 → 커밋)은 2026-08-25에
완료됨. 남은 건 이것뿐:

1. **새 모델 배포(git push) 후 실기기로 확인** — 헬멧 인식률 개선 체감되는지, 그리고
   안전조끼(no_vest) 오탐(사용자가 2026-08-21 보고)도 같이 개선됐는지 확인.
2. 조끼 오탐이 여전히 남으면 그때 조끼 전용 보강 데이터셋 조사·다운로드·
   `merge_datasets.py`에 변환 함수 추가 → `merged_yolo/` 재생성 → 다음 재학습에 포함
   (헬멧 때와 동일한 패턴).
