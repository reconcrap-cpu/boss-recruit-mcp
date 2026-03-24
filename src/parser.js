const SEARCH_SCHOOL_MAP = {
  "985": "985院校",
  "211": "211院校",
  "qs100": "QS 100"
};

function normalizeText(input) {
  return String(input || "").replace(/\s+/g, " ").trim();
}

function uniqueList(items) {
  return Array.from(new Set(items.filter(Boolean)));
}

function extractCity(text) {
  const explicitPatterns = [
    /地点(?:在|是|为|:|：)?\s*([^\s，。；;、]+)/i,
    /城市(?:在|是|为|:|：)?\s*([^\s，。；;、]+)/i
  ];

  for (const pattern of explicitPatterns) {
    const m = text.match(pattern);
    if (m && m[1]) {
      return m[1].trim();
    }
  }

  return null;
}

function extractDegree(text) {
  if (/(博士及以上|博士)/.test(text)) return "博士";
  if (/(硕士及以上|硕士以上)/.test(text)) return "硕士及以上";
  if (/(本科及以上|本科以上)/.test(text)) return "本科及以上";
  if (/本科/.test(text)) return "本科";
  return null;
}

function extractSchools(text) {
  const schools = [];
  if (/(^|[^0-9])985([^0-9]|$)/.test(text)) schools.push(SEARCH_SCHOOL_MAP["985"]);
  if (/(^|[^0-9])211([^0-9]|$)/.test(text)) schools.push(SEARCH_SCHOOL_MAP["211"]);
  if (/(qs\s*100|QS\s*100|qs100|QS100)/.test(text)) schools.push(SEARCH_SCHOOL_MAP["qs100"]);
  return uniqueList(schools);
}

function extractKeywordExplicit(text) {
  const patterns = [
    /搜索关键词(?:为|是|:|：)?\s*([^\n，。；;]+)/i,
    /关键词(?:为|是|:|：)?\s*([^\n，。；;]+)/i,
    /keyword(?:\s*[:：=]\s*|\s+is\s+)([^\n，。；;]+)/i
  ];

  for (const pattern of patterns) {
    const m = text.match(pattern);
    if (m && m[1]) {
      const kw = m[1].trim();
      if (kw) return kw;
    }
  }
  return null;
}

function extractKeywordAuto(text) {
  const patterns = [
    /做过\s*([A-Za-z0-9+#./\-\s]{2,40}?)(?:的人选|的人|相关|并且|且|，|。|,|$)/i,
    /有过\s*([A-Za-z0-9+#./\-\s]{2,40}?)(?:经验|背景|的人选|并且|且|，|。|,|$)/i,
    /从事过\s*([A-Za-z0-9+#./\-\s]{2,40}?)(?:相关|的人选|并且|且|，|。|,|$)/i
  ];

  for (const pattern of patterns) {
    const m = text.match(pattern);
    if (m && m[1]) {
      const kw = m[1].replace(/\s+/g, " ").trim();
      if (kw.length >= 2) return kw;
    }
  }
  return null;
}

function extractTargetCount(text) {
  const patterns = [
    /至少筛选\s*(\d+)\s*位?/i,
    /目标(?:筛选)?(?:人数|数量)?(?:为|是|:|：)?\s*(\d+)/i,
    /目标(?:筛选)?(?:人数|数量)?\s*(\d+)\s*人/i,
    /筛选\s*(\d+)\s*位/i
  ];

  for (const pattern of patterns) {
    const m = text.match(pattern);
    if (m && m[1]) {
      const n = Number.parseInt(m[1], 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

function sanitizeClause(clause) {
  return clause
    .replace(/^使用boss-recruit-pipeline skills/i, "")
    .replace(/^帮我(?:在boss上)?(?:找|筛选)/i, "")
    .replace(/^请(?:在boss上)?(?:帮我)?(?:找|筛选)/i, "")
    .replace(/^在boss上(?:帮我)?(?:找|筛选)/i, "")
    .replace(/的人选$/, "")
    .replace(/的人$/, "")
    .trim();
}

function buildScreenCriteria(text, searchParams) {
  const clauses = text
    .split(/[，,。；;\n]/)
    .map((s) => sanitizeClause(s))
    .filter(Boolean);

  const filtered = clauses.filter((clause) => {
    if (/搜索关键词|关键词|keyword/i.test(clause)) return false;
    if (/地点|城市/.test(clause)) return false;
    if (/学历|本科|硕士|博士/.test(clause) && !/论文|项目|经验/.test(clause)) return false;
    if (/985|211|qs\s*100|QS\s*100|院校/.test(clause) && !/论文|经验|项目/.test(clause)) return false;
    if (/至少筛选|目标人数|目标数量|筛选\d+位/.test(clause)) return false;
    return true;
  });

  const normalized = filtered
    .map((clause) => clause.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  if (searchParams?.keyword) {
    const keywordClause = `候选人需有${searchParams.keyword}相关经历`;
    const alreadyCovered = normalized.some((clause) =>
      clause.toLowerCase().includes(String(searchParams.keyword).toLowerCase())
    );
    if (!alreadyCovered) {
      normalized.unshift(keywordClause);
    }
  }

  if (normalized.length === 0) {
    return searchParams?.keyword
      ? `候选人需有${searchParams.keyword}相关经历`
      : text;
  }
  return uniqueList(normalized).join("；");
}

function resolveKeyword(parsed, confirmation) {
  const explicit = parsed.keyword_explicit;
  const auto = parsed.keyword_auto;
  const confirmed = confirmation && confirmation.keyword_confirmed === true;
  const rejected = confirmation && confirmation.keyword_confirmed === false;
  const value = confirmation && typeof confirmation.keyword_value === "string"
    ? confirmation.keyword_value.trim()
    : "";

  if (confirmed && value) {
    return { keyword: value, needsConfirmation: false, proposedKeyword: null };
  }

  if (explicit) {
    return { keyword: explicit, needsConfirmation: false, proposedKeyword: null };
  }

  if (rejected) {
    return { keyword: value || null, needsConfirmation: false, proposedKeyword: null };
  }

  if (auto) {
    if (confirmed) {
      return { keyword: auto, needsConfirmation: false, proposedKeyword: null };
    }
    return { keyword: null, needsConfirmation: true, proposedKeyword: auto };
  }

  return { keyword: null, needsConfirmation: false, proposedKeyword: null };
}

export function parseRecruitInstruction({ instruction, confirmation, overrides }) {
  const text = normalizeText(instruction);
  const parsed = {
    city: extractCity(text),
    degree: extractDegree(text),
    schools: extractSchools(text),
    keyword_explicit: extractKeywordExplicit(text),
    keyword_auto: extractKeywordAuto(text),
    target_count: extractTargetCount(text)
  };

  if (overrides && Number.isFinite(overrides.target_count) && overrides.target_count > 0) {
    parsed.target_count = Number.parseInt(String(overrides.target_count), 10);
  }

  const keywordResolution = resolveKeyword(parsed, confirmation);
  const searchParams = {
    city: parsed.city,
    degree: parsed.degree,
    schools: parsed.schools,
    keyword: keywordResolution.keyword
  };

  const screenParams = {
    criteria: buildScreenCriteria(text, searchParams),
    target_count: parsed.target_count
  };

  const missing = [];
  if (!searchParams.city) missing.push("city");
  if (!searchParams.degree) missing.push("degree");
  if (!searchParams.schools || searchParams.schools.length === 0) missing.push("schools");
  if (!searchParams.keyword) missing.push("keyword");
  if (!screenParams.target_count) missing.push("target_count");

  return {
    parsed,
    searchParams,
    screenParams,
    missing_fields: missing,
    needs_keyword_confirmation: keywordResolution.needsConfirmation,
    proposed_keyword: keywordResolution.proposedKeyword
  };
}
