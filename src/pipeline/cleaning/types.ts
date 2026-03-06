import type { PipelineError } from '../errors.js';
import type { Provenance } from '../provenance.js';

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

export type CleaningInputDto = {
  raw_text: string;
  body_text?: string;
  provenance: Provenance;
  message_id: string;
};

export type CleaningOutputDto = {
  raw_text: string;
  clean_text: string;
  body_text: string;
  signals: CleaningSignals;
  pii: CleaningPii;
  provenance: Provenance;
  errors: PipelineError[];
};
