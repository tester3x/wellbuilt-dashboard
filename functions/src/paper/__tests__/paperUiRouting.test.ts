import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(__dirname, '../../../../src/components');
const modal = readFileSync(join(root, 'TicketDetailModal.tsx'), 'utf8');
const editor = readFileSync(join(root, 'TicketStructuredEditor.tsx'), 'utf8');

describe('flag-ON route uses distinct governed surfaces', () => {
  it('edit_form, read_only_detail, canonical_paper, policy_undefined, and route failure are distinct', () => {
    expect(modal).toContain('TicketStructuredEditor');
    expect(modal).toContain('TicketReadOnlyDetail');
    expect(modal).toContain('CanonicalTicketPaperHost');
    expect(modal).toContain('TicketPolicyUnavailable');
    expect(modal).toContain('TicketRouteFailure');
    const canonicalFn = modal.slice(modal.indexOf('function TicketDetailModalCanonical'), modal.indexOf('export function TicketDetailModal'));
    expect(canonicalFn).not.toContain('TicketDetailModalLegacy');
    expect(canonicalFn).not.toContain('className="hidden"');
    expect(canonicalFn).toContain('Back to editor');
    expect(editor).toContain('Preview paper');
    expect(editor).toContain('data-paper-rejected-draft');
  });
});
