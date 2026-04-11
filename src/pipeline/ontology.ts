export const TAG_ALLOWLIST = {
  seniority: ['intern', 'junior', 'mid', 'senior', 'staff', 'principal', 'lead', 'manager', 'director', 'vp', 'cxo'],
  manage: ['ic', 'lead', 'manager', 'head', 'director'],
  tier: ['t0', 't1', 't2', 't3', 't4', 'reject'],
  scope: ['local', 'regional', 'national', 'global', 'remote', 'hybrid', 'onsite'],
  tech: ['frontend', 'backend', 'fullstack', 'mobile', 'data', 'ml', 'ai', 'infra', 'devops', 'security', 'platform'],
  proto: ['idea', 'prototype', 'mvp', 'production', 'scale'],
  design: ['system', 'product', 'ux', 'ui', 'architecture', 'research'],
  signal: ['urgent', 'strong', 'medium', 'weak', 'high-confidence', 'low-confidence'],
  visa: ['none', 'required', 'sponsored', 'available'],
  location: null
} as const;

export type TagCategory = keyof typeof TAG_ALLOWLIST;

export const MULTI_VALUE_CATEGORIES = new Set<TagCategory>(['scope', 'tech', 'proto', 'design', 'signal']);
export const SINGLE_VALUE_CATEGORIES = new Set<TagCategory>(['seniority', 'manage', 'tier', 'visa', 'location']);

export function isAllowedTagValue(category: TagCategory, value: string): boolean {
  const allowlist = TAG_ALLOWLIST[category];
  if (allowlist === null) {
    return value.trim().length > 0;
  }

  return allowlist.includes(value as never);
}
