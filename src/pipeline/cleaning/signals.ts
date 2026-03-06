import type { CleaningPii, CleaningSignals } from './types.js';

const EMAIL_REGEX = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_REGEX = /\b(?:\+?\d{1,2}[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}\b/g;
const SSN_REGEX = /\b\d{3}-\d{2}-\d{4}\b/g;

export function detectPii(text: string): CleaningPii {
  const email_count = (text.match(EMAIL_REGEX) ?? []).length;
  const phone_count = (text.match(PHONE_REGEX) ?? []).length;
  const ssn_count = (text.match(SSN_REGEX) ?? []).length;

  return {
    contains_email: email_count > 0,
    contains_phone: phone_count > 0,
    contains_ssn: ssn_count > 0,
    email_count,
    phone_count,
    ssn_count
  };
}

export function computeSignals(opts: {
  rawText: string;
  cleanText: string;
  bodyText: string;
  removedChars: number;
}): CleaningSignals {
  const raw_length = opts.rawText.length;
  const clean_length = opts.cleanText.length;
  const body_length = opts.bodyText.length;
  const compression_ratio = raw_length === 0 ? 1 : clean_length / raw_length;
  const boilerplate_ratio = raw_length === 0 ? 0 : Math.min(1, opts.removedChars / raw_length);

  const lengthQuality = clean_length === 0 ? 0 : Math.min(1, clean_length / 1200);
  const compressionPenalty = Math.max(0, Math.abs(0.65 - compression_ratio));
  const quality = Number(Math.max(0, Math.min(1, lengthQuality - compressionPenalty)).toFixed(3));

  const confidence = Number(Math.max(0, Math.min(1, 1 - boilerplate_ratio * 0.6)).toFixed(3));

  return {
    confidence,
    quality,
    raw_length,
    clean_length,
    body_length,
    compression_ratio: Number(compression_ratio.toFixed(3)),
    boilerplate_ratio: Number(boilerplate_ratio.toFixed(3))
  };
}
