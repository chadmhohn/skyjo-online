import { createPortal } from 'react-dom';
import { StrictMode, useRef, useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useModalFocus } from '../../../src/accessibility';

function ModalHarness() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  useModalFocus({
    open,
    dialogRef,
    initialFocusRef: headingRef,
    triggerRef,
    onDismiss: () => setOpen(false)
  });

  return (
    <div data-testid="app-content">
      <button onClick={() => setOpen(true)} ref={triggerRef} type="button">
        Open modal
      </button>
      <button type="button">Outside action</button>
      {open
        ? createPortal(
            <div data-modal-overlay data-testid="modal-overlay">
              <section aria-labelledby="modal-title" aria-modal="true" ref={dialogRef} role="dialog" tabIndex={-1}>
                <h1 id="modal-title" ref={headingRef} tabIndex={-1}>
                  Focus contract
                </h1>
                <input data-testid="hidden-input" type="hidden" />
                <button style={{ display: 'none' }} type="button">
                  CSS hidden action
                </button>
                <button type="button">First action</button>
                <button onClick={() => setOpen(false)} type="button">
                  Close modal
                </button>
              </section>
            </div>,
            document.body
          )
        : null}
    </div>
  );
}

describe('modal focus contract', () => {
  it('survives StrictMode, traps boundary focus, inerts content, and restores its opener', async () => {
    const actor = userEvent.setup();
    render(
      <StrictMode>
        <ModalHarness />
      </StrictMode>
    );
    const opener = screen.getByRole('button', { name: 'Open modal' });
    await actor.click(opener);

    const heading = await screen.findByRole('heading', { name: 'Focus contract' });
    await Promise.resolve();
    expect(heading).toHaveFocus();
    expect(document.body.style.overflow).toBe('hidden');
    expect(screen.getByTestId('app-content').parentElement).toHaveAttribute('inert');

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(screen.getByRole('button', { name: 'Close modal' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(screen.getByRole('button', { name: 'First action' })).toHaveFocus();

    screen.getByRole('button', { name: 'Outside action' }).focus();
    expect(heading).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Focus contract' })).not.toBeInTheDocument());
    await waitFor(() => expect(opener).toHaveFocus());
    expect(document.body.style.overflow).toBe('');
    expect(screen.getByTestId('app-content').parentElement).not.toHaveAttribute('inert');
  });
});
