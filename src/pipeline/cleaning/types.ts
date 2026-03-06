export type CleaningSignals = {
  confidence: number;
  quality: number;
  raw_length: number;
  clean_length: number;
  body_length: number;
  compression_ratio: number;
  boilerplate_ratio: number;
};

export type CleaningPii = {
  contains_email: boolean;
  contains_phone: boolean;
  contains_ssn: boolean;
  email_count: number;
  phone_count: number;
  ssn_count: number;
};

export type CleaningProvenance = {
  source: string;
  run_id?: string;
  account_email?: string;
  message_id?: string;
  thread_id?: string;
  internal_date?: number;
  label?: string;
};

export type CleaningError = {
  code: string;
  message: string;
};

export type CleaningInputDto = {
  raw_text: string;
  body_text?: string;
  provenance: CleaningProvenance;
};

export type CleaningOutputDto = {
  raw_text: string;
  clean_text: string;
  body_text: string;
  signals: CleaningSignals;
  pii: CleaningPii;
  provenance: CleaningProvenance;
  errors: CleaningError[];
};
