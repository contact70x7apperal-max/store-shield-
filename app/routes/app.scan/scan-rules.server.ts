// Each rule is a concrete, testable pattern — deliberately narrow to avoid
// false-positive noise. This list is a starting point, not exhaustive.
export const scanRules: {
  id: string;
  severity: "high" | "medium" | "low";
  pattern: RegExp;
  message: string;
}[] = [
  {
    id: "exposed-stripe-live-key",
    severity: "high",
    pattern: /sk_live_[0-9a-zA-Z]{16,}/,
    message: "Hardcoded Stripe live secret key found in theme source.",
  },
  {
    id: "exposed-generic-secret",
    severity: "high",
    pattern: /(api[_-]?key|secret|access[_-]?token)\s*[:=]\s*["'][A-Za-z0-9_\-]{20,}["']/i,
    message: "Possible hardcoded API key/secret/token literal.",
  },
  {
    id: "inline-event-handler",
    severity: "medium",
    pattern: /on(click|error|load|mouseover)\s*=\s*"[^"]*document\.write/i,
    message: "Inline event handler calling document.write — a common XSS pattern.",
  },
  {
    id: "outdated-jquery",
    severity: "medium",
    pattern: /jquery[.-](1\.[0-9]|2\.[01])\S*\.js/i,
    message: "Loading a jQuery version with known, publicly documented vulnerabilities.",
  },
  {
    id: "eval-usage",
    severity: "low",
    pattern: /\beval\s*\(/,
    message: "Use of eval() — hard to audit and a common injection sink.",
  },
];
