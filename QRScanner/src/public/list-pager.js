/**
 * list-pager.js -- previous/next paging for the server-paged lists (tickets
 * and orders). The API returns { total, page, pageSize } with each page; this
 * draws "Page X of Y (N results)", Previous/Next and a page-size choice into
 * any element with class "list-pager", and calls onChange(page, pageSize).
 *
 *   const pager = createListPager({ pageSize: 100, onChange: (page, size) => reload(page, size) });
 *   pager.update(total, page, pageSize);
 */
(function () {
    const SIZES = [25, 50, 100, 200];

    function createListPager({ pageSize = 100, onChange }) {
        const state = { page: 1, pageSize, total: 0 };
        const containers = Array.from(document.querySelectorAll('.list-pager'));

        function pages() { return Math.max(1, Math.ceil(state.total / state.pageSize)); }

        function render() {
            const last = pages();
            for (const box of containers) {
                box.innerHTML = '';
                box.hidden = state.total <= SIZES[0] && state.page === 1;
                if (box.hidden) continue;

                const prev = document.createElement('button');
                prev.type = 'button';
                prev.className = 'btn btn-sm btn-outline-secondary';
                prev.textContent = '← Previous';
                prev.disabled = state.page <= 1;
                prev.addEventListener('click', () => go(state.page - 1));

                const info = document.createElement('span');
                info.className = 'list-pager-info';
                info.textContent = `Page ${state.page} of ${last} (${state.total.toLocaleString('en-US')} results)`;

                const next = document.createElement('button');
                next.type = 'button';
                next.className = 'btn btn-sm btn-outline-secondary';
                next.textContent = 'Next →';
                next.disabled = state.page >= last;
                next.addEventListener('click', () => go(state.page + 1));

                const size = document.createElement('select');
                size.className = 'form-select form-select-sm list-pager-size';
                size.style.width = 'auto';
                size.setAttribute('aria-label', 'Results per page');
                for (const n of SIZES) {
                    const option = document.createElement('option');
                    option.value = String(n);
                    option.textContent = `${n} per page`;
                    option.selected = n === state.pageSize;
                    size.appendChild(option);
                }
                size.addEventListener('change', () => {
                    state.pageSize = Number(size.value);
                    go(1);
                });

                box.append(prev, info, next, size);
            }
        }

        function go(page) {
            state.page = Math.min(Math.max(1, page), pages());
            onChange(state.page, state.pageSize);
        }

        return {
            get page() { return state.page; },
            get pageSize() { return state.pageSize; },
            /** Start again at page 1 (a new search or date range). */
            reset() { state.page = 1; },
            /** Show what the server returned; past the last page (rows removed), go to the last one. */
            update(total, page, size) {
                state.total = Number(total) || 0;
                state.page = Number(page) || 1;
                state.pageSize = Number(size) || state.pageSize;
                render();
                if (state.total > 0 && state.page > pages()) go(pages());
            }
        };
    }

    window.createListPager = createListPager;
})();
