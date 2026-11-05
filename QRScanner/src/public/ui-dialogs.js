// ui-dialogs.js -- the site's message, confirm and prompt dialogs, plus
// inline form-field errors. Replaces the browser's alert()/confirm()/
// prompt() so every page has the same look as the hand-built modals (Cancel
// Order etc.). Uses Bootstrap's modal CSS but not its JavaScript, so it also
// works on the scanner page (no Bootstrap bundle) and can open on top of a
// Bootstrap modal that's already showing.
//
//   await UIDialogs.showMessage({ type: 'success', title: 'Order cancelled', message: '...' });
//   (also takes details: small grey text, and link: { href, text })
//   if (await UIDialogs.showConfirm({ title: 'Delete post?', message: '...', confirmText: 'Delete Post', danger: true })) { ... }
//   const name = await UIDialogs.showPrompt({ title: 'Save preset', label: 'Preset name' });  // null if cancelled
//   UIDialogs.fieldError(inputEl, 'Please choose a date');  // red text under the field until it's edited
//
// Text is always set with textContent, never innerHTML, so server messages
// and user input can't inject markup.
(function () {
    const HEADER_CLASSES = {
        success: 'bg-success text-white',
        error: 'bg-danger text-white',
        warning: 'bg-warning text-dark',
        info: ''
    };

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = text;
        return node;
    }

    // Builds and shows one dialog. Resolves with whatever close(value) is
    // given: the button's value, or `dismissValue` for Escape / the X /
    // clicking outside.
    function openDialog({ type = 'info', title, message, details, link, buttons, dismissValue, input }) {
        return new Promise((resolve) => {
            const previousFocus = document.activeElement;

            const backdrop = el('div', 'modal-backdrop fade show ui-dialog-backdrop');
            const modal = el('div', 'modal fade show d-block ui-dialog');
            modal.setAttribute('role', 'dialog');
            modal.setAttribute('aria-modal', 'true');
            modal.tabIndex = -1;

            const dialog = el('div', 'modal-dialog modal-dialog-centered');
            const content = el('div', 'modal-content');

            const headerColor = HEADER_CLASSES[type] ?? '';
            const header = el('div', `modal-header ${headerColor}`.trim());
            const titleEl = el('h5', 'modal-title', title || '');
            titleEl.id = `ui-dialog-title-${Date.now()}`;
            modal.setAttribute('aria-labelledby', titleEl.id);
            const closeX = el('button', `btn-close${headerColor.includes('text-white') ? ' btn-close-white' : ''}`);
            closeX.type = 'button';
            closeX.setAttribute('aria-label', 'Close');
            header.append(titleEl, closeX);

            const body = el('div', 'modal-body');
            if (message) body.appendChild(el('p', 'mb-0 ui-dialog-message', message));
            let inputEl = null;
            let inputError = null;
            if (input) {
                const group = el('div', message ? 'mt-3' : '');
                const inputId = `ui-dialog-input-${Date.now()}`;
                if (input.label) {
                    const label = el('label', 'form-label', input.label);
                    label.htmlFor = inputId;
                    group.appendChild(label);
                }
                inputEl = el('input', 'form-control');
                inputEl.id = inputId;
                inputEl.type = 'text';
                inputEl.value = input.value || '';
                if (input.placeholder) inputEl.placeholder = input.placeholder;
                inputError = el('div', 'invalid-feedback');
                group.append(inputEl, inputError);
                body.appendChild(group);
            }
            // Optional link (e.g. "View in Square"); http(s) only
            if (link && /^https?:\/\//i.test(link.href || '')) {
                const linkEl = el('a', '', link.text || link.href);
                linkEl.href = link.href;
                linkEl.target = '_blank';
                linkEl.rel = 'noopener';
                const linkP = el('p', 'mt-3 mb-0');
                linkP.appendChild(linkEl);
                body.appendChild(linkP);
            }
            if (details) body.appendChild(el('p', 'text-muted small mt-3 mb-0 ui-dialog-details', details));

            const footer = el('div', 'modal-footer');
            const buttonEls = buttons.map((b) => {
                const button = el('button', `btn ${b.className}`, b.text);
                button.type = 'button';
                button.addEventListener('click', () => {
                    if (b.submitsInput) {
                        const value = inputEl.value.trim();
                        if (!value) {
                            inputEl.classList.add('is-invalid');
                            inputError.textContent = input.requiredMessage || 'Please enter a value.';
                            inputEl.focus();
                            return;
                        }
                        close(value);
                    } else {
                        close(b.value);
                    }
                });
                footer.appendChild(button);
                return button;
            });

            content.append(header, body, footer);
            dialog.appendChild(content);
            modal.appendChild(dialog);

            function onKey(event) {
                if (event.key === 'Escape') {
                    event.preventDefault();
                    close(dismissValue);
                } else if (event.key === 'Enter' && inputEl && document.activeElement === inputEl) {
                    event.preventDefault();
                    buttonEls[buttonEls.length - 1].click();
                }
            }

            let closed = false;
            function close(value) {
                if (closed) return;
                closed = true;
                document.removeEventListener('keydown', onKey, true);
                modal.remove();
                backdrop.remove();
                if (!document.querySelector('.ui-dialog') && !document.querySelector('.modal.show:not(.ui-dialog)')) {
                    document.body.classList.remove('ui-dialog-open');
                }
                if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
                resolve(value);
            }

            closeX.addEventListener('click', () => close(dismissValue));
            modal.addEventListener('mousedown', (event) => {
                if (event.target === modal) close(dismissValue);
            });
            if (inputEl) inputEl.addEventListener('input', () => inputEl.classList.remove('is-invalid'));
            document.addEventListener('keydown', onKey, true);

            document.body.append(backdrop, modal);
            document.body.classList.add('ui-dialog-open');
            (inputEl || buttonEls[buttonEls.length - 1]).focus();
        });
    }

    // One OK button. type: 'success' | 'error' | 'warning' | 'info'.
    function showMessage({ type = 'info', title, message, details, link } = {}) {
        const defaults = { success: 'Done', error: 'Something went wrong', warning: 'Heads up', info: 'Notice' };
        return openDialog({
            type,
            title: title || defaults[type] || 'Notice',
            message,
            details,
            link,
            dismissValue: undefined,
            buttons: [{ text: 'OK', className: type === 'error' ? 'btn-danger' : 'btn-primary', value: undefined }]
        });
    }

    // Resolves true (confirmed) or false (cancelled / dismissed).
    function showConfirm({ title = 'Are you sure?', message, details, confirmText = 'OK', cancelText = 'Cancel', danger = false } = {}) {
        return openDialog({
            type: danger ? 'error' : 'info',
            title,
            message,
            details,
            dismissValue: false,
            buttons: [
                { text: cancelText, className: 'btn-secondary', value: false },
                { text: confirmText, className: danger ? 'btn-danger' : 'btn-primary', value: true }
            ]
        });
    }

    // Resolves the trimmed text, or null if cancelled. An empty value is
    // refused inline, like a required field.
    function showPrompt({ title, message, label, placeholder, value, confirmText = 'Save', cancelText = 'Cancel', requiredMessage } = {}) {
        return openDialog({
            type: 'info',
            title,
            message,
            input: { label, placeholder, value, requiredMessage },
            dismissValue: null,
            buttons: [
                { text: cancelText, className: 'btn-secondary', value: null },
                { text: confirmText, className: 'btn-primary', submitsInput: true }
            ]
        });
    }

    // ---- Inline form errors ----

    // Shows `message` in red under `field` (an input, select or textarea, or
    // a container for groups like radio buttons) and focuses it. The error
    // clears as soon as the field is edited. Always returns false, so a
    // check can read `if (!date) return UIDialogs.fieldError(dateInput, '...');`.
    function fieldError(field, message) {
        if (!field) {
            showMessage({ type: 'warning', title: 'Check the form', message });
            return false;
        }
        clearFieldError(field);
        field.classList.add('is-invalid');
        const feedback = el('div', 'invalid-feedback d-block ui-field-error', message);
        // Bootstrap's input-group needs the message after the group, not inside it
        const anchor = field.closest('.input-group') || field;
        anchor.insertAdjacentElement('afterend', feedback);
        field._uiFieldError = feedback;
        const clear = () => clearFieldError(field);
        field.addEventListener('input', clear, { once: true });
        field.addEventListener('change', clear, { once: true });
        if (typeof field.focus === 'function') field.focus();
        if (typeof field.scrollIntoView === 'function') field.scrollIntoView({ block: 'center', behavior: 'smooth' });
        return false;
    }

    function clearFieldError(field) {
        if (!field) return;
        field.classList.remove('is-invalid');
        if (field._uiFieldError) {
            field._uiFieldError.remove();
            field._uiFieldError = null;
        }
    }

    // Clears every inline error inside `container` (a form or modal), e.g.
    // when a modal is reopened for a different record.
    function clearFieldErrors(container) {
        (container || document).querySelectorAll('.is-invalid').forEach(clearFieldError);
        (container || document).querySelectorAll('.ui-field-error').forEach((node) => node.remove());
    }

    // A Bootstrap modal reopened for a different record shouldn't still show
    // the last record's inline errors (Bootstrap's events bubble to document).
    document.addEventListener('hidden.bs.modal', (event) => clearFieldErrors(event.target));

    // Reads a fetch response's JSON even when the status is an error, so the
    // server's returnStatus/message can be shown instead of a generic failure.
    // Throws only when there's no JSON at all.
    async function readJson(response) {
        try {
            return await response.json();
        } catch {
            throw new Error(`The server answered ${response.status} with no details`);
        }
    }

    window.UIDialogs = { showMessage, showConfirm, showPrompt, fieldError, clearFieldError, clearFieldErrors, readJson };
})();
