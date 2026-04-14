export const TAG_ALLOWLIST = {
  seniority: ['grad', 'junior', 'mid', 'senior', 'principal', 'fellow'],
  manage: ['small', 'medium', 'large', 'other'],
  tier: ['1', '2', '3', '4'],
  scope: ['ip', 'core', 'subsystem', 'soc', 'fullchip'],
  tech: ['systemverilog', 'uvm', 'formal', 'cocotb', 'python', 'verilator', 'agentic'],
  proto: ['axi', 'ahb', 'apb', 'pci', 'usb', 'ethernet', 'ddr', 'lpddr', 'hbm', 'ucie', 'cxl', 'serdes', 'spi', 'i2c', 'uart', 'mipi', 'can', 'lin', 'high_speed'],
  design: ['cpu', 'gpu', 'dsp', 'npu', 'cache', 'coherency', 'memory', 'ddr', 'ai_accelerator', 'fpga', 'networking', 'automotive', 'wireless', 'storage', 'multimedia'],
  signal: ['digital', 'analog', 'ams'],
  visa: ['issue', 'no_issues', 'undefined'],
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
