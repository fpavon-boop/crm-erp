import { describe, it, expect } from 'vitest';
import {
  TEMPLATE_KEYS,
  TEMPLATE_DEFINITIONS,
  renderTemplate,
  renderAllTemplates,
  textToHtml,
  type CommunicationTemplateContext,
} from '../src/lib/communications/templates';

/**
 * Phase 10 (Customer Communication): pure-function tests for template
 * rendering and parameter interpolation — no database needed, since
 * renderTemplate() is a deterministic function of its input context. See
 * docs/CUSTOMER_COMMUNICATION.md.
 */
describe('communication templates', () => {
  const fullContext: CommunicationTemplateContext = {
    recipientName: 'Jane Smith',
    orderNumber: 'SO-2026-0042',
    orderTotal: 1234.5,
    invoiceNumber: 'INV-2026-0099',
    invoiceTotal: 1234.5,
    balanceDue: 500,
    dueDate: new Date(2026, 9, 1), // Oct 1, 2026 local time — avoids UTC-string timezone shift
    quoteNumber: 'Q-2026-0007',
    quoteTotal: 2000,
    paymentAmount: 734.5,
    paymentMethod: 'Credit card',
  };

  it('every template key has a definition with at least one channel', () => {
    for (const key of TEMPLATE_KEYS) {
      const def = TEMPLATE_DEFINITIONS[key];
      expect(def).toBeDefined();
      expect(def.channels.length).toBeGreaterThan(0);
    }
  });

  it('renders all 7 required templates without throwing, each producing a non-empty body', () => {
    expect(TEMPLATE_KEYS.length).toBe(7);
    for (const key of TEMPLATE_KEYS) {
      const rendered = renderTemplate(key, fullContext);
      expect(rendered.body.length).toBeGreaterThan(0);
      expect(rendered.body).toContain('Jane Smith');
    }
  });

  it('order_confirmation interpolates the order number and total', () => {
    const rendered = renderTemplate('order_confirmation', fullContext);
    expect(rendered.subject).toContain('SO-2026-0042');
    expect(rendered.body).toContain('SO-2026-0042');
    expect(rendered.body).toContain('$1,234.50');
  });

  it('payment_reminder interpolates the invoice number, balance due, and due date', () => {
    const rendered = renderTemplate('payment_reminder', fullContext);
    expect(rendered.body).toContain('INV-2026-0099');
    expect(rendered.body).toContain('$500.00');
    expect(rendered.body).toContain('Oct 1, 2026');
  });

  it('payment_confirmation interpolates the payment amount and method', () => {
    const rendered = renderTemplate('payment_confirmation', fullContext);
    expect(rendered.body).toContain('$734.50');
    expect(rendered.body).toContain('Credit card');
    expect(rendered.body).toContain('INV-2026-0099');
  });

  it('quote_follow_up interpolates the quote number and total', () => {
    const rendered = renderTemplate('quote_follow_up', fullContext);
    expect(rendered.subject).toContain('Q-2026-0007');
    expect(rendered.body).toContain('$2,000.00');
  });

  it('every template still renders a natural, non-broken draft with no record-specific data at all (the company-level Send form case)', () => {
    const minimal: CommunicationTemplateContext = { recipientName: 'Acme Co' };
    for (const key of TEMPLATE_KEYS) {
      const rendered = renderTemplate(key, minimal);
      expect(rendered.body).not.toContain('undefined');
      expect(rendered.body).not.toContain('null');
      expect(rendered.subject ?? '').not.toContain('undefined');
      expect(rendered.body).toContain('Acme Co');
    }
  });

  it('falls back to "there" when no recipient name is given at all', () => {
    const rendered = renderTemplate('order_confirmation', { recipientName: '' });
    expect(rendered.body).toContain('Hi there,');
  });

  it('renderAllTemplates returns a rendering for every template key, matching renderTemplate for each', () => {
    const all = renderAllTemplates(fullContext);
    expect(Object.keys(all).sort()).toEqual([...TEMPLATE_KEYS].sort());
    for (const key of TEMPLATE_KEYS) {
      expect(all[key]).toEqual(renderTemplate(key, fullContext));
    }
  });

  describe('textToHtml', () => {
    it('wraps blank-line-separated paragraphs in <p> tags', () => {
      const html = textToHtml('First paragraph.\n\nSecond paragraph.');
      expect(html).toBe('<p>First paragraph.</p><p>Second paragraph.</p>');
    });

    it('escapes HTML-significant characters so injected content cannot break out of the markup', () => {
      const html = textToHtml('Order <script>alert(1)</script> & "quotes"');
      expect(html).not.toContain('<script>');
      expect(html).toContain('&lt;script&gt;');
      expect(html).toContain('&amp;');
    });

    it('converts single newlines within a paragraph to <br/>', () => {
      const html = textToHtml('Line one\nLine two');
      expect(html).toBe('<p>Line one<br/>Line two</p>');
    });
  });
});
