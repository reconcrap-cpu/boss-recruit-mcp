const SEARCH_SCHOOL_MAP = {
  "统招": "统招本科",
  "统招本科": "统招本科",
  "统招本": "统招本科",
  "全日制本科": "统招本科",
  "双一流": "双一流院校",
  "双一流院校": "双一流院校",
  "双一流学校": "双一流院校",
  "985": "985院校",
  "985院校": "985院校",
  "211": "211院校",
  "211院校": "211院校",
  "qs": "QS 100",
  "qs100": "QS 100",
  "qs500": "QS 500"
};
const KNOWN_SCHOOL_LABELS = new Set(Object.values(SEARCH_SCHOOL_MAP));
const DEFAULT_PARAM_VALUES = {
  city: null,
  degree: "不限",
  schools: [],
  keyword: "算法工程师",
  target_count: 10
};
const DEFAULT_PARAM_LABELS = {
  city: "不限城市",
  degree: "不限",
  schools: "不限院校标签",
  keyword: "算法工程师",
  target_count: 10
};
const DEGREE_VALUES = new Set(["不限", "本科", "本科及以上", "硕士及以上", "博士"]);
const CITY_STOP_PATTERN = /(?:筛选|搜索|查找|找|做过|从事过|有过|相关|的人选|的人|并且|且|学历|学校|目标|必须|优先|，|。|；|;|,)/;

function normalizeText(input) {
  return String(input || "").replace(/\s+/g, " ").trim();
}

function uniqueList(items) {
  return Array.from(new Set(items.filter(Boolean)));
}

function normalizeSchoolLabel(value) {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;

  if (KNOWN_SCHOOL_LABELS.has(raw)) {
    return raw;
  }

  const compact = raw.toLowerCase().replace(/\s+/g, "");
  const qsMatch = compact.match(/^qs(\d+)$/);
  if (qsMatch) {
    const rank = Number.parseInt(qsMatch[1], 10);
    if (Number.isFinite(rank)) {
      return rank > 100 ? SEARCH_SCHOOL_MAP.qs500 : SEARCH_SCHOOL_MAP.qs100;
    }
  }
  return SEARCH_SCHOOL_MAP[compact] || SEARCH_SCHOOL_MAP[raw] || raw;
}

function sanitizeCityCandidate(value) {
  if (typeof value !== "string") return null;
  let candidate = value.trim();
  if (!candidate) return null;

  candidate = candidate.replace(/^(在|是|为)\s*/, "").trim();
  const stopIndex = candidate.search(CITY_STOP_PATTERN);
  if (stopIndex >= 0) {
    candidate = candidate.slice(0, stopIndex).trim();
  }

  candidate = candidate.replace(/[的\s]+$/g, "").trim();
  return candidate || null;
}

function extractCity(text) {
  const explicitPatterns = [
    /地点(?:在|是|为|:|：)?\s*([^\n，。；;、]+)/i,
    /城市(?:在|是|为|:|：)?\s*([^\n，。；;、]+)/i,
    /工作地(?:在|是|为|:|：)?\s*([^\n，。；;、]+)/i,
    /base(?:在|是|为|:|：)?\s*([^\n，。；;、]+)/i
  ];

  for (const pattern of explicitPatterns) {
    const m = text.match(pattern);
    if (m && m[1]) {
      const city = sanitizeCityCandidate(m[1]);
      if (city) return city;
    }
  }

  return null;
}

function extractDegree(text) {
  if (/(博士及以上|博士)/.test(text)) return "博士";
  if (/(硕士及以上|硕士以上)/.test(text)) return "硕士及以上";
  if (/硕士/.test(text)) return "硕士";
  if (/(本科及以上|本科以上)/.test(text)) return "本科及以上";
  if (/本科/.test(text)) return "本科";
  return null;
}

function extractSchools(text) {
  const schools = [];
  if (/统招(?:本科)?/.test(text)) schools.push(SEARCH_SCHOOL_MAP["统招"]);
  if (/双一流(?:院校|学校)?/.test(text)) schools.push(SEARCH_SCHOOL_MAP["双一流"]);
  if (/(^|[^0-9])985([^0-9]|$)/.test(text)) schools.push(SEARCH_SCHOOL_MAP["985"]);
  if (/(^|[^0-9])211([^0-9]|$)/.test(text)) schools.push(SEARCH_SCHOOL_MAP["211"]);
  const qsMatches = text.matchAll(/\bqs\s*(\d+)\b/ig);
  for (const match of qsMatches) {
    const rank = Number.parseInt(match[1], 10);
    if (Number.isFinite(rank)) {
      schools.push(rank > 100 ? SEARCH_SCHOOL_MAP.qs500 : SEARCH_SCHOOL_MAP.qs100);
    }
  }
  return uniqueList(schools);
}

function extractRecentViewedFilter(text) {
  const negativePatterns = [
    /(?:不|别|无需|不用|不要).{0,6}(?:过滤|排除|去掉|剔除).{0,8}(?:近?14天(?:内)?查看(?:过)?)/i,
    /(?:保留|包含).{0,8}(?:近?14天(?:内)?查看(?:过)?)/i,
    /(?:近?14天(?:内)?查看(?:过)?).{0,8}(?:不要|不用|无需|不需要|不必).{0,4}(?:过滤|排除|去掉|剔除)/i
  ];

  for (const pattern of negativePatterns) {
    if (pattern.test(text)) {
      return false;
    }
  }

  const positivePatterns = [
    /(?:过滤|排除|去掉|剔除).{0,8}(?:近?14天(?:内)?查看(?:过)?)/i,
    /(?:近?14天(?:内)?查看(?:过)?).{0,8}(?:过滤|排除|去掉|剔除)/i
  ];

  for (const pattern of positivePatterns) {
    if (pattern.test(text)) {
      return true;
    }
  }

  return null;
}

function normalizeStringOverride(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function normalizeSchoolsOverride(value) {
  if (Array.isArray(value)) {
    return uniqueList(value.map(normalizeSchoolLabel));
  }

  if (typeof value === "string") {
    return uniqueList(value.split(/[，,]/).map(normalizeSchoolLabel));
  }

  return null;
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

function isCountPlanningClause(clause) {
  return /(?:目标(?:筛选)?(?:人数|数量)?|至少筛选|筛选\s*\d+\s*位|输出\s*\d+\s*(?:位|个|个人选|个候选人)?|最终输出\s*\d+\s*(?:位|个|个人选|个候选人)?|处理\s*\d+\s*(?:位|人)|(?:浏览|拉取|抓取).*(?:至少\s*)?\d+\s*(?:位|个|个人选|个候选人)?|最匹配.*\d+\s*(?:位|个|个人选|个候选人)?)/i.test(clause);
}

function buildScreenCriteria(text, searchParams) {
  const clauses = text
    .split(/[，,。；;\n]/)
    .map((s) => sanitizeClause(s))
    .filter(Boolean);

  const filtered = clauses.filter((clause) => {
    if (/搜索关键词|关键词|keyword/i.test(clause)) return false;
    if (/地点|城市/.test(clause)) return false;
    if (/近?14天(?:内)?查看(?:过)?|过滤近14天查看/.test(clause)) return false;
    if (isCountPlanningClause(clause)) return false;
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
  if (parsed.keyword_override) {
    return { keyword: parsed.keyword_override, needsConfirmation: false, proposedKeyword: null };
  }

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

function collectSuspiciousFields(searchParams, screenParams) {
  const suspicious = [];

  if (searchParams.city && (/\s/.test(searchParams.city) || CITY_STOP_PATTERN.test(searchParams.city) || searchParams.city.length > 8)) {
    suspicious.push({
      field: "city",
      value: searchParams.city,
      reason: "城市提取结果看起来包含多余短语，请确认是否为标准城市名。"
    });
  }

  if (searchParams.degree && !DEGREE_VALUES.has(searchParams.degree)) {
    suspicious.push({
      field: "degree",
      value: searchParams.degree,
      reason: "学历提取结果不在预期枚举内，请确认。"
    });
  }

  if (searchParams.keyword && /城市|学历|学校|目标人数|目标数量|筛选\d+位/i.test(searchParams.keyword)) {
    suspicious.push({
      field: "keyword",
      value: searchParams.keyword,
      reason: "关键词看起来混入了筛选条件，请确认是否只保留核心方向词。"
    });
  }

  if (screenParams.target_count && (!Number.isInteger(screenParams.target_count) || screenParams.target_count <= 0)) {
    suspicious.push({
      field: "target_count",
      value: screenParams.target_count,
      reason: "目标人数不是有效正整数，请确认。"
    });
  }

  return suspicious;
}

function buildDefaultPreview(missingFields, options = {}) {
  const { skipKeywordDefault = false } = options;
  return missingFields.reduce((acc, field) => {
    if (field === "keyword" && skipKeywordDefault) {
      return acc;
    }
    acc[field] = DEFAULT_PARAM_LABELS[field];
    return acc;
  }, {});
}

function applyDefaults(searchParams, screenParams, missingFields, useDefaultForMissing, options = {}) {
  const { skipKeywordDefault = false } = options;
  if (!useDefaultForMissing) {
    return {
      searchParams,
      screenParams,
      appliedDefaults: {}
    };
  }

  const appliedDefaults = {};
  const nextSearchParams = { ...searchParams };
  const nextScreenParams = { ...screenParams };

  if (missingFields.includes("city")) {
    nextSearchParams.city = DEFAULT_PARAM_VALUES.city;
    appliedDefaults.city = DEFAULT_PARAM_LABELS.city;
  }
  if (missingFields.includes("degree")) {
    nextSearchParams.degree = DEFAULT_PARAM_VALUES.degree;
    appliedDefaults.degree = DEFAULT_PARAM_LABELS.degree;
  }
  if (missingFields.includes("schools")) {
    nextSearchParams.schools = DEFAULT_PARAM_VALUES.schools.slice();
    appliedDefaults.schools = DEFAULT_PARAM_LABELS.schools;
  }
  if (missingFields.includes("keyword") && !skipKeywordDefault) {
    nextSearchParams.keyword = DEFAULT_PARAM_VALUES.keyword;
    appliedDefaults.keyword = DEFAULT_PARAM_LABELS.keyword;
  }
  if (missingFields.includes("target_count")) {
    nextScreenParams.target_count = DEFAULT_PARAM_VALUES.target_count;
    appliedDefaults.target_count = DEFAULT_PARAM_LABELS.target_count;
  }

  return {
    searchParams: nextSearchParams,
    screenParams: nextScreenParams,
    appliedDefaults
  };
}

export function parseRecruitInstruction({ instruction, confirmation, overrides }) {
  const text = normalizeText(instruction);
  const parsed = {
    city: extractCity(text),
    degree: extractDegree(text),
    schools: extractSchools(text),
    filter_recent_viewed: extractRecentViewedFilter(text),
    keyword_explicit: extractKeywordExplicit(text),
    keyword_auto: extractKeywordAuto(text),
    target_count: extractTargetCount(text)
  };

  if (overrides) {
    const overrideCity = sanitizeCityCandidate(normalizeStringOverride(overrides.city));
    const overrideDegree = normalizeStringOverride(overrides.degree);
    const overrideSchools = normalizeSchoolsOverride(overrides.schools);
    const overrideKeyword = normalizeStringOverride(overrides.keyword);
    const overrideRecentViewed = typeof overrides.filter_recent_viewed === "boolean"
      ? overrides.filter_recent_viewed
      : null;

    if (overrideCity) parsed.city = overrideCity;
    if (overrideDegree) parsed.degree = overrideDegree;
    if (overrideSchools && overrideSchools.length > 0) parsed.schools = overrideSchools;
    if (overrideKeyword) parsed.keyword_override = overrideKeyword;
    if (overrideRecentViewed !== null) parsed.filter_recent_viewed = overrideRecentViewed;

    if (Number.isFinite(overrides.target_count) && overrides.target_count > 0) {
      parsed.target_count = Number.parseInt(String(overrides.target_count), 10);
    }
  }

  const keywordResolution = resolveKeyword(parsed, confirmation);
  const baseSearchParams = {
    city: parsed.city,
    degree: parsed.degree,
    schools: parsed.schools,
    filter_recent_viewed: parsed.filter_recent_viewed,
    keyword: keywordResolution.keyword
  };

  const baseScreenParams = {
    criteria: buildScreenCriteria(text, baseSearchParams),
    target_count: parsed.target_count
  };

  const missingBeforeDefaults = [];
  if (!baseSearchParams.city) missingBeforeDefaults.push("city");
  if (!baseSearchParams.degree) missingBeforeDefaults.push("degree");
  if (!baseSearchParams.schools || baseSearchParams.schools.length === 0) missingBeforeDefaults.push("schools");
  if (!baseSearchParams.keyword) missingBeforeDefaults.push("keyword");
  if (!baseScreenParams.target_count) missingBeforeDefaults.push("target_count");

  const useDefaultForMissing = confirmation?.use_default_for_missing === true;
  const skipKeywordDefault = keywordResolution.needsConfirmation;
  const defaultPreview = buildDefaultPreview(missingBeforeDefaults, { skipKeywordDefault });
  const { searchParams, screenParams, appliedDefaults } = applyDefaults(
    baseSearchParams,
    baseScreenParams,
    missingBeforeDefaults,
    useDefaultForMissing,
    { skipKeywordDefault }
  );
  const suspicious_fields = collectSuspiciousFields(searchParams, screenParams);
  const needs_recent_viewed_filter_confirmation = searchParams.filter_recent_viewed === null;
  const needs_criteria_confirmation = confirmation?.criteria_confirmed !== true;
  const pending_questions = [
    ...(needs_recent_viewed_filter_confirmation
      ? [
      {
        field: "filter_recent_viewed",
        question: "是否需要过滤近14天查看过的人选？",
        options: [
          { label: "需要过滤", value: true },
          { label: "不过滤", value: false }
        ]
      }
    ]
      : []),
    ...(needs_criteria_confirmation
      ? [
        {
          field: "criteria",
          question: "请确认筛选 criteria 是否准确无误（尤其是硬性约束条件）？",
          value: baseScreenParams.criteria
        }
      ]
      : [])
  ];

  return {
    parsed,
    searchParams,
    screenParams,
    missing_fields: missingBeforeDefaults,
    has_unresolved_missing_fields: missingBeforeDefaults.length > 0 && !useDefaultForMissing,
    suspicious_fields,
    needs_keyword_confirmation: keywordResolution.needsConfirmation,
    needs_recent_viewed_filter_confirmation,
    needs_criteria_confirmation,
    needs_search_params_confirmation: confirmation?.search_params_confirmed !== true,
    proposed_keyword: keywordResolution.proposedKeyword,
    pending_questions,
    default_preview: defaultPreview,
    applied_defaults: appliedDefaults,
    review: {
      extracted_search_params: baseSearchParams,
      extracted_screen_params: baseScreenParams,
      current_search_params: searchParams,
      current_screen_params: screenParams,
      missing_fields: missingBeforeDefaults,
      has_unresolved_missing_fields: missingBeforeDefaults.length > 0 && !useDefaultForMissing,
      suspicious_fields,
      pending_questions,
      default_preview: defaultPreview,
      applied_defaults: appliedDefaults
    }
  };
}
