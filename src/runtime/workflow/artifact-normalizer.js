export function normalizeReviewerArtifact(rawContent) {
  const queue = [String(rawContent ?? '')];
  const seen = new Set();
  const candidates = [];
  while (queue.length) {
    const value = queue.shift();
    if (typeof value !== 'string' || seen.has(value)) continue;
    seen.add(value);
    candidates.push(value);
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed === 'string') queue.push(parsed);
      else if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item === 'string') queue.push(item);
          else if (typeof item?.text === 'string') queue.push(item.text);
          else if (typeof item?.content === 'string') queue.push(item.content);
        }
      } else if (typeof parsed?.text === 'string') queue.push(parsed.text);
      else if (typeof parsed?.content === 'string') queue.push(parsed.content);
    } catch {}
  }

  const valid = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !value.review) return false;
    const review = value.review;
    return typeof review === 'object'
      && typeof review.requirementsSatisfied === 'boolean'
      && typeof review.architectureConformant === 'boolean'
      && Array.isArray(review.implementationIssues)
      && Array.isArray(review.evidenceIssues)
      && Array.isArray(review.blockingIssues)
      && review.implementationIssues.every(v => typeof v === 'string')
      && review.evidenceIssues.every(v => typeof v === 'string')
      && review.blockingIssues.every(v => typeof v === 'string');
  };

  for (const source of candidates) {
    for (const text of [source, source.replace(/\\"/g, '"')]) {
      const marker = text.lastIndexOf('{"review"');
      if (marker < 0) continue;
      let depth = 0; let inString = false; let escaped = false;
      for (let i = marker; i < text.length; i += 1) {
        const ch = text[i];
        if (inString) {
          if (escaped) escaped = false;
          else if (ch === '\\') escaped = true;
          else if (ch === '"') inString = false;
          continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (ch === '{') depth += 1;
        else if (ch === '}') {
          depth -= 1;
          if (depth === 0) {
            try {
              const parsed = JSON.parse(text.slice(marker, i + 1));
              if (valid(parsed)) return JSON.stringify(parsed);
            } catch {}
            break;
          }
        }
      }
    }
  }
  return null;
}

export function parseReviewerArtifact(rawContent) {
  const normalized = normalizeReviewerArtifact(rawContent);
  return normalized ? JSON.parse(normalized) : null;
}
