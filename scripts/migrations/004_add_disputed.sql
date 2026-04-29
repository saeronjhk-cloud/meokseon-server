-- disputed 상태 추가 (Gemini 피드백: 오류 신고 파이프라인)
ALTER TYPE verification_status ADD VALUE IF NOT EXISTS 'disputed';
