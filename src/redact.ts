const secretPatterns: Array<[RegExp, string]> = [
  [/(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g, "$1[REDACTED]$2"],
  [/(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, "$1[REDACTED]"],
  [/(\b(?:sk|ghp|gho|github_pat|xoxb|xoxp)-)[A-Za-z0-9_-]{8,}/gi, "$1[REDACTED]"],
  [/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|token|secret|password|passwd|authorization)\s*[=:]\s*)[^\s;,}&]+/gi, "$1[REDACTED]"],
  [/(--(?:api[_-]?key|access[_-]?token|token|secret|password)(?:=|\s+))[^\s]+/gi, "$1[REDACTED]"],
  [/(https?:\/\/[^\s?]+\?[^\s]*)(?:key|token|secret|password)=[^&\s]+/gi, "$1[REDACTED]"],
  [/(\bcli_[A-Za-z0-9]{10,}\b)(\s+)([A-Za-z0-9_-]{20,})/g, "$1$2[REDACTED]"],
  [/(\b[A-Fa-f0-9]{24,}:)[A-Za-z0-9+\/_=-]{20,}/g, "$1[REDACTED]"],
  [/(\b(?:app\s*id|appid)\s*[=:：]?\s*cli_[A-Za-z0-9]{10,}\s+)[A-Za-z0-9_-]{20,}/gi, "$1[REDACTED]"],
];

export function redact(text: string, terms: string[] = []) {
  let result = String(text ?? "");
  for (const [pattern, replacement] of secretPatterns) result = result.replace(pattern, replacement);
  for (const term of terms.map(value => value.trim()).filter(value => value.length >= 2).slice(0, 50)) {
    result = result.replace(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "[REDACTED_TERM]");
  }
  return result;
}
