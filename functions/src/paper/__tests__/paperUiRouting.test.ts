import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(__dirname, '../../../../src');
const modal = readFileSync(join(root, 'components/TicketDetailModal.tsx'), 'utf8');
const editor = readFileSync(join(root, 'components/TicketReviewEditor.tsx'), 'utf8');
const routed = readFileSync(join(root, 'components/TicketPaperRoutedView.tsx'), 'utf8');
const dispatch = readFileSync(join(root, 'app/dispatch/page.tsx'), 'utf8');

describe('flag-ON route uses distinct governed surfaces', () => {
  it('edit_form, read_only_detail, canonical_paper, policy_undefined, and route failure are distinct', () => {
    expect(modal).toContain('TicketPaperRoutedView');
    expect(modal).not.toContain('TicketStructuredEditor');
    expect(routed).toContain('TicketReviewEditor');
    expect(routed).toContain('TicketReadOnlyDetail');
    expect(routed).toContain('CanonicalTicketPaperHost');
    expect(routed).toContain('TicketPolicyUnavailable');
    expect(routed).toContain('TicketRouteFailure');
    expect(editor).toContain("type={NUMERIC.has(field) ? 'number' : 'text'}");
    expect(editor).toContain('Preview paper');
    expect(dispatch).toContain('TicketPaperRoutedView');
    expect(dispatch).not.toMatch(/isCanonicalPaperEnabled\(\) && \(\s*<CanonicalTicketPaperHost/);
    expect(routed).toContain('structured_record_unavailable');
    expect(routed).not.toContain("id: '', ticketNumber: ''");
    expect(editor).toContain('reviewVersion');
    expect(editor).toContain('version_conflict');
  });
});
