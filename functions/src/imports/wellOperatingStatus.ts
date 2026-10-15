/** Explicit present-tense well status only; ordinary routing/loading words are not signals. */
export function extractWellOperatingStatus(text: string): {
  gaugeText: string; wellDown?: boolean; evidence?: string; ambiguous: boolean;
} {
  const signals: Array<{ down: boolean; text: string }> = [];
  let ambiguous = false;
  const down = /^(?:down|off|offline|shut[ -]?in|shut\s*down|turned\s+off|not\s+(?:pumping|producing))$/i;
  const up = /^(?:up|on|live|online|back\s+(?:up|on|online)|turned\s+(?:back\s+)?on|pumping|producing|running)$/i;
  const lines = text.split(/\n|;/).map(line => {
    const gaugeStatus = /^(\s*[@:\-]?\s*\d{1,2}(?:\s*['’′]\s*\d{0,2}\s*["”″]?|[.,]\d{1,2}|\s*ft)?)\s+(off|on|down|up|live|online)\s*[.!]?$/i.exec(line);
    if (gaugeStatus) { signals.push({ down: down.test(gaugeStatus[2]), text: gaugeStatus[2] }); return gaugeStatus[1]; }
    // An explicit "well ..." footer can accompany a gauge or barrel line.
    const explicit = /\bwell\s+(?:(?:is|still|now|currently)\s+)*(down|off|offline|shut[ -]?in|shut\s*down|turned\s+off|not\s+(?:pumping|producing)|up|on|live|online|back\s+(?:up|on|online)|turned\s+(?:back\s+)?on|pumping|producing|running)\b/ig;
    const matches = [...line.matchAll(explicit)];
    if (matches.length) {
      for (const match of matches) {
        const before = line.slice(0, match.index).trim();
        const after = line.slice((match.index || 0) + match[0].length).trim();
        if (/[?]/.test(line) || /\b(?:not|if|maybe|might|could|will|was|wasn't|isn't|isnt|wasnt|turn\s+(?:the\s+)?|switch\s+(?:the\s+)?)\s*$/i.test(before) || /^(?:to\b|the\b|site\b|location\b|my\b|tomorrow\b|later\b)/i.test(after)) {
          ambiguous = true; continue;
        }
        signals.push({ down: down.test(match[1]), text: match[0] });
      }
      return line.replace(explicit, '').replace(/^[\s,.:!\-]+|[\s,.:!\-]+$/g, '');
    }
    const bare = line.trim().replace(/^(?:it\s+(?:is\s+)?|(?:still|now|currently)\s+)/i, '').replace(/[.!]+$/, '').trim();
    if (down.test(bare) || up.test(bare)) { signals.push({ down: down.test(bare), text: line.trim() }); return ''; }
    return line;
  });
  if (signals.some(s => s.down) && signals.some(s => !s.down)) ambiguous = true;
  return { gaugeText: lines.filter(line => line.trim()).join('\n'), ambiguous,
    ...(!ambiguous && signals.length ? { wellDown: signals[0].down, evidence: signals.map(s => s.text).join('; ') } : {}) };
}
