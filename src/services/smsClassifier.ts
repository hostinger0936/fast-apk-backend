export type SmsCategory = "debit" | "credit" | "balance";

export type SmsClassificationResult = {
  isFinance: boolean;
  categories: SmsCategory[];
  matchedKeywords: string[];
};

function normalizeText(input: unknown): string {
  return String(input ?? "")
    .toLowerCase()
    .replace(/[|:_,-]+/g, " ")
    .replace(/[()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function keywordToRegex(keyword: string): RegExp {
  const source = escapeRegex(keyword.trim())
    .replace(/\\&/g, "(?:\\&|and)")
    .replace(/\\\//g, "(?:\\/|\\s*)")
    .replace(/ /g, "[\\s-]+");

  return new RegExp(`(?:^|\\b)${source}(?:\\b|$)`, "i");
}

function matchKeywords(text: string, keywords: string[]): string[] {
  const matches: string[] = [];

  for (const keyword of keywords) {
    if (keywordToRegex(keyword).test(text)) {
      matches.push(keyword);
    }
  }

  return matches;
}

function matchPatterns(
  text: string,
  patterns: Array<{ label: string; regex: RegExp }>,
): string[] {
  const matches: string[] = [];

  for (const pattern of patterns) {
    if (pattern.regex.test(text)) {
      matches.push(pattern.label);
    }
  }

  return matches;
}

const FINANCE_KEYWORDS = [
  "bank",
  "banking",
  "a/c",
  "a/c no",
  "a/c x",
  "acct",
  "account",
  "account no",
  "account ending",
  "card",
  "card xx",
  "debit card",
  "credit card",
  "upi",
  "imps",
  "neft",
  "rtgs",
  "bbps",
  "atm",
  "pos",
  "txn",
  "txn id",
  "utr",
  "transaction",
  "payment",
  "merchant",
  "vpa",
  "debited",
  "credited",
  "withdrawn",
  "withdrawal",
  "deposited",
  "spent",
  "received",
  "balance",
  "avl bal",
  "available balance",
  "avbl bal",
  "avail bal",
  "current balance",
  "closing balance",
  "ledger balance",
  "inr",
  "rs",
  "rs.",
  "credited to",
  "debited by",
  "debited for",
  "credited with",
];

const BANK_NAME_KEYWORDS = [
  // Public sector
  "state bank of india",
  "sbi",
  "bank of baroda",
  "bob",
  "bank of india",
  "boi",
  "bank of maharashtra",
  "canara bank",
  "central bank of india",
  "indian bank",
  "indian overseas bank",
  "iob",
  "punjab national bank",
  "pnb",
  "punjab and sind bank",
  "punjab & sind bank",
  "uco bank",
  "union bank",
  "union bank of india",

  // Private sector
  "axis bank",
  "axis",
  "bandhan bank",
  "csb bank",
  "city union bank",
  "cub",
  "dcb bank",
  "dhanlaxmi bank",
  "federal bank",
  "hdfc bank",
  "hdfc",
  "icici bank",
  "icici",
  "indusind bank",
  "indusind",
  "idfc first bank",
  "idfc",
  "idbi bank",
  "jammu and kashmir bank",
  "j&k bank",
  "jk bank",
  "karnataka bank",
  "karur vysya bank",
  "kvb",
  "kotak mahindra bank",
  "kotak",
  "nainital bank",
  "rbl bank",
  "rbl",
  "south indian bank",
  "sib",
  "tamilnad mercantile bank",
  "tmb",
  "yes bank",

  // Small finance banks
  "au small finance bank",
  "capital small finance bank",
  "equitas small finance bank",
  "esaf small finance bank",
  "suryoday small finance bank",
  "ujjivan small finance bank",
  "utkarsh small finance bank",
  "jana small finance bank",
  "shivalik small finance bank",
  "unity small finance bank",
  "north east small finance bank",
  "slice small finance bank",

  // Payments banks
  "airtel payments bank",
  "india post payments bank",
  "ippb",
  "fino payments bank",
  "paytm payments bank",
  "jio payments bank",
  "nsdl payments bank",

  // Local area banks
  "coastal local area bank",
  "krishna bhima samruddhi local area bank",
  "krishna bhima samruddhi lab",

  // RRBs / gramin banks
  "andhra pradesh grameena bank",
  "assam gramin bank",
  "arunachal pradesh rural bank",
  "bihar gramin bank",
  "chhattisgarh gramin bank",
  "gujarat gramin bank",
  "haryana gramin bank",
  "himachal pradesh gramin bank",
  "jharkhand gramin bank",
  "jammu and kashmir grameen bank",
  "karnataka grameena bank",
  "kerala grameena bank",
  "maharashtra gramin bank",
  "madhya pradesh gramin bank",
  "manipur rural bank",
  "meghalaya rural bank",
  "mizoram rural bank",
  "nagaland rural bank",
  "odisha grameen bank",
  "punjab gramin bank",
  "puducherry grama bank",
  "rajasthan gramin bank",
  "tamil nadu grama bank",
  "telangana grameena bank",
  "tripura gramin bank",
  "uttar pradesh gramin bank",
  "uttarakhand gramin bank",
  "west bengal gramin bank",

  // Generic co-op / regional words
  "state cooperative bank",
  "state co operative bank",
  "state co-operative bank",
  "state cooperative apex bank",
  "state co operative apex bank",
  "state co-operative apex bank",
  "district central cooperative bank",
  "district central co operative bank",
  "district central co-operative bank",
  "district cooperative bank",
  "district co operative bank",
  "district co-operative bank",
  "central cooperative bank",
  "central co operative bank",
  "central co-operative bank",
  "cooperative apex bank",
  "co operative apex bank",
  "co-operative apex bank",
  "sahakari bank",
  "sahkari bank",
  "sahakara bank",
  "nagrik sahakari bank",
  "nagari sahakari bank",
  "grameen bank",
  "gramin bank",
  "grama bank",
  "rural bank",
];

const DEBIT_KEYWORDS = [
  "debited",
  "debit",
  "spent",
  "withdrawn",
  "withdraw",
  "withdrawal",
  "purchase",
  "paid",
  "payment done",
  "payment of",
  "sent via upi",
  "sent an amount",
  "transfer to",
  "transferred to",
  "dr",
  "dr.",
  "cash withdrawal",
  "atm wd",
  "upi txn",
  "upi transfer",
  "pos txn",
  "purchase txn",
  "bill paid",
  "deducted",
];

const CREDIT_KEYWORDS = [
  "credited",
  "credit",
  "deposited",
  "received",
  "received from",
  "amount received",
  "cr",
  "cr.",
  "salary credited",
  "refund processed",
  "refund of",
  "cashback",
  "amount added",
  "deposit by cash",
  "deposit",
  "reversal",
  "reversed",
  "transferred from",
  "upi received",
];

const BALANCE_KEYWORDS = [
  "avl bal",
  "available balance",
  "avail bal",
  "avbl bal",
  "balance is",
  "bal is",
  "current balance",
  "closing balance",
  "ledger bal",
  "ledger balance",
  "clear balance",
  "remaining balance",
  "total balance",
  "updated balance",
];

const FINANCE_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  { label: "amount_inr", regex: /\b(?:inr|rs\.?|mrp rs\.?)\s*[\d,]+(?:\.\d{1,2})?\b/i },
  { label: "account_masked", regex: /\b(?:a\/c|acct|account)\s*(?:no\.?)?\s*(?:xx|x{2,}|\*{2,})?[\d*x]{2,}\b/i },
  { label: "upi_ref", regex: /\b(?:upi|utr|txn id|txnid|rrn|ref(?:erence)? id)\b/i },

  // generic bank families
  {
    label: "state_cooperative_bank",
    regex: /\b(?:state|rajya)\s+(?:co[\s-]?operative|coop(?:erative)?|sahakari|sahkari|sahakara)(?:\s+apex)?\s+bank\b/i,
  },
  {
    label: "district_cooperative_bank",
    regex: /\b(?:district|dist(?:rict)?|jila|zilla|jill?a?)\s+(?:central\s+)?(?:co[\s-]?operative|coop(?:erative)?|sahakari|sahkari|sahakara)\s+bank\b/i,
  },
  {
    label: "gramin_or_rural_bank",
    regex: /\b(?:grameen|gramin|grameena|grama|rural)\s+bank\b/i,
  },
  {
    label: "payments_bank",
    regex: /\b[a-z][a-z\s&.-]*payments\s+bank\b/i,
  },
  {
    label: "small_finance_bank",
    regex: /\b[a-z][a-z\s&.-]*small\s+finance\s+bank\b/i,
  },
  {
    label: "local_area_bank",
    regex: /\blocal\s+area\s+bank\b/i,
  },
  {
    label: "cooperative_apex_bank",
    regex: /\b(?:co[\s-]?operative|coop(?:erative)?|sahakari|sahkari|sahakara)\s+apex\s+bank\b/i,
  },
  {
    label: "nagrik_sahakari_bank",
    regex: /\b(?:nagrik|nagari)\s+(?:sahakari|sahkari|co[\s-]?operative)\s+bank\b/i,
  },
];

const DEBIT_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  { label: "debited", regex: /\bdebited\b/i },
  { label: "debit_amount", regex: /\b(?:debited|spent|paid|withdrawn|deducted)\b.*?\b(?:inr|rs\.?)\s*[\d,]+(?:\.\d{1,2})?\b/i },
  { label: "dr_marker", regex: /(?:^|\s)dr(?:\.|\s|$)/i },
  { label: "atm_withdrawal", regex: /\b(?:cash withdrawal|atm wd|atm withdrawal)\b/i },
  { label: "upi_sent", regex: /\b(?:sent via upi|upi transfer|transferred to|payment done|bill paid)\b/i },
  { label: "purchase_pos", regex: /\b(?:purchase|pos txn|purchase txn|merchant payment)\b/i },
];

const CREDIT_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  { label: "credited", regex: /\bcredited\b/i },
  { label: "credit_amount", regex: /\b(?:credited|received|deposited|refund|cashback|reversal|reversed)\b.*?\b(?:inr|rs\.?)\s*[\d,]+(?:\.\d{1,2})?\b/i },
  { label: "cr_marker", regex: /(?:^|\s)cr(?:\.|\s|$)/i },
  { label: "salary", regex: /\bsalary credited\b/i },
  { label: "upi_received", regex: /\b(?:upi received|received from|transferred from)\b/i },
];

const BALANCE_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  { label: "available_balance", regex: /\b(?:avl bal|avbl bal|avail bal|available balance)\b/i },
  { label: "balance_is", regex: /\b(?:balance is|bal is|current balance|closing balance|ledger bal|ledger balance)\b/i },
  { label: "balance_amount", regex: /\b(?:balance|bal)\b.*?\b(?:inr|rs\.?)\s*[\d,]+(?:\.\d{1,2})?\b/i },
];

// sender ko bhi pass karo
export function classifySms(text: unknown, sender?: unknown): SmsClassificationResult {
  const normalized = normalizeText(`${sender ?? ""} ${text ?? ""}`);

  if (!normalized) {
    return {
      isFinance: false,
      categories: [],
      matchedKeywords: [],
    };
  }

  const financeMatches = [
    ...matchKeywords(normalized, FINANCE_KEYWORDS),
    ...matchKeywords(normalized, BANK_NAME_KEYWORDS),
    ...matchPatterns(normalized, FINANCE_PATTERNS),
  ];

  const debitMatches = [
    ...matchKeywords(normalized, DEBIT_KEYWORDS),
    ...matchPatterns(normalized, DEBIT_PATTERNS),
  ];

  const creditMatches = [
    ...matchKeywords(normalized, CREDIT_KEYWORDS),
    ...matchPatterns(normalized, CREDIT_PATTERNS),
  ];

  const balanceMatches = [
    ...matchKeywords(normalized, BALANCE_KEYWORDS),
    ...matchPatterns(normalized, BALANCE_PATTERNS),
  ];

  const matchedKeywords = Array.from(
    new Set([
      ...financeMatches,
      ...debitMatches,
      ...creditMatches,
      ...balanceMatches,
    ]),
  );

  const categories: SmsCategory[] = [];

  const isFinance =
    financeMatches.length > 0 ||
    debitMatches.length > 0 ||
    creditMatches.length > 0 ||
    balanceMatches.length > 0;

  if (!isFinance) {
    return {
      isFinance: false,
      categories: [],
      matchedKeywords: [],
    };
  }

  if (debitMatches.length > 0) {
    categories.push("debit");
  }

  if (creditMatches.length > 0) {
    categories.push("credit");
  }

  if (balanceMatches.length > 0) {
    categories.push("balance");
  }

  return {
    isFinance: true,
    categories,
    matchedKeywords,
  };
}

export default {
  classifySms,
};