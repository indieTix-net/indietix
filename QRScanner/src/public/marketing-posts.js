// marketing-posts.js -- the Posts page: every marketing post, one page at a
// time, in four tabs (Needs review, Scheduled, Sent, Problems), grouped by
// show. Drafts can be approved one at a time, a page's worth by checkbox, or
// every draft for a show at once. Backed by /api/marketing/posts (see
// "MARKETING POSTS PAGE" in app.mjs) plus the single-post routes the
// Marketing page always used.
(function() {
    'use strict';

    const API_URL = window.INDIETIX_API_URL;
    const TABS = ['review', 'scheduled', 'sent', 'problems'];
    const CHANNEL_LABELS = { email: 'Email', facebook: 'Facebook', instagram: 'Instagram', tiktok: 'TikTok' };
    const EMPTY_MESSAGES = {
        review: 'No drafts waiting for review.',
        scheduled: 'Nothing approved and waiting to go out.',
        sent: 'Nothing has been sent yet.',
        problems: 'No failed or skipped posts.'
    };

    const params = new URLSearchParams(window.location.search);
    let tab = TABS.includes(params.get('tab')) ? params.get('tab') : 'review';
    let posts = [];
    let itemNames = {};
    let draftCounts = {};
    const selected = new Set();
    const pager = window.createListPager({ pageSize: 50, onChange: () => load() });

    function authHeaders() {
        return { 'Content-Type': 'application/json', ...window.getAuthHeaders() };
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str == null ? '' : String(str);
        return div.innerHTML;
    }

    // For text inside an HTML attribute value (quotes too).
    function escapeAttr(str) {
        return escapeHtml(str).replace(/"/g, '&quot;');
    }

    // ScheduledFor is the venue's wall-clock time. pg + JSON hand it back with
    // a trailing Z that does NOT mean UTC, so read the digits directly (same
    // as marketing.js's formatWallClockDateTime).
    function formatWallClock(value) {
        const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(value || '');
        if (!match) return value || '';
        const [, y, m, d, h, min] = match;
        return new Date(Number(y), Number(m) - 1, Number(d), Number(h), Number(min))
            .toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    }

    function itemName(id) {
        return itemNames[id] || id;
    }

    function plural(n, word) {
        return `${n} ${word}${n === 1 ? '' : 's'}`;
    }

    // "Email 3, Facebook 3, Instagram 3"
    function channelBreakdown(byChannel) {
        return Object.keys(CHANNEL_LABELS)
            .filter(c => byChannel[c])
            .map(c => `${CHANNEL_LABELS[c]} ${byChannel[c]}`)
            .join(', ');
    }

    // =====================================================
    // LOADING
    // =====================================================

    function filters() {
        return {
            item: document.getElementById('filter-item').value,
            channel: document.getElementById('filter-channel').value,
            from: document.getElementById('filter-from').value,
            to: document.getElementById('filter-to').value,
            search: document.getElementById('filter-search').value.trim()
        };
    }

    async function loadItems() {
        try {
            const response = await fetch(`${API_URL}/api/marketing/posts/items`, { headers: authHeaders() });
            const data = await response.json();
            if (!data.success) return;
            const select = document.getElementById('filter-item');
            const current = select.value;
            select.innerHTML = '<option value="">All shows</option>' + data.items
                .map(i => `<option value="${escapeAttr(i.id)}">${escapeHtml(i.name)}</option>`).join('');
            select.value = current;
        } catch (error) {
            console.error('Error loading show list:', error);
        }
    }

    async function load() {
        const container = document.getElementById('posts-container');
        const url = new URL(`${API_URL}/api/marketing/posts`);
        url.searchParams.set('tab', tab);
        url.searchParams.set('page', pager.page);
        url.searchParams.set('pageSize', pager.pageSize);
        for (const [key, value] of Object.entries(filters())) {
            if (value) url.searchParams.set(key, value);
        }

        try {
            const response = await fetch(url, { headers: authHeaders() });
            const data = await response.json();
            if (!data.success) {
                container.innerHTML = `<p class="text-danger">${escapeHtml(data.message || 'The posts could not be loaded.')}</p>`;
                return;
            }
            posts = data.posts;
            itemNames = data.itemNames || {};
            draftCounts = data.draftCounts || {};
            for (const id of [...selected]) {
                if (!posts.some(p => p.ID === id)) selected.delete(id);
            }
            renderCounts(data.counts || {});
            render();
            pager.update(data.total, data.page, data.pageSize);
        } catch (error) {
            console.error('Error loading posts:', error);
            container.innerHTML = '<p class="text-danger">The posts could not be loaded. Please try again.</p>';
        }
    }

    // A new tab or filter starts again at page 1.
    function reload() {
        pager.reset();
        selected.clear();
        load();
    }

    // =====================================================
    // RENDERING
    // =====================================================

    function renderCounts(counts) {
        for (const name of TABS) {
            const badge = document.querySelector(`[data-count="${name}"]`);
            const n = counts[name] || 0;
            badge.textContent = n ? n.toLocaleString('en-US') : '';
            badge.className = `badge ${name === 'problems' && n ? 'bg-danger' : 'bg-secondary'}`;
        }
    }

    function renderTabs() {
        document.querySelectorAll('#posts-tabs .nav-link').forEach(link => {
            link.classList.toggle('active', link.dataset.tab === tab);
            link.setAttribute('aria-selected', String(link.dataset.tab === tab));
        });
        document.getElementById('selection-bar').hidden = tab !== 'review';
    }

    // Posts arrive in date order; each show becomes one block, in the order
    // its first post appears on this page.
    function groupByShow() {
        const groups = new Map();
        for (const post of posts) {
            if (!groups.has(post.SquareItemID)) groups.set(post.SquareItemID, []);
            groups.get(post.SquareItemID).push(post);
        }
        return [...groups.entries()];
    }

    function render() {
        renderTabs();
        const container = document.getElementById('posts-container');
        if (!posts.length) {
            const filtered = Object.values(filters()).some(Boolean);
            container.innerHTML = `<p class="text-muted posts-empty">${filtered ? 'No posts match these filters.' : EMPTY_MESSAGES[tab]}</p>`;
            renderSelection();
            return;
        }

        container.innerHTML = groupByShow().map(([itemId, groupPosts]) => {
            const drafts = draftCounts[itemId];
            const approveAll = tab === 'review' && drafts && drafts.total > 1
                ? `<button type="button" class="btn btn-sm btn-primary" data-action="approve-show" data-item="${escapeAttr(itemId)}">Approve all ${drafts.total} drafts for this show</button>`
                : '';
            const subtitle = tab === 'review' && drafts
                ? `${plural(drafts.total, 'draft')} in all (${channelBreakdown(drafts.byChannel)})`
                : plural(groupPosts.length, 'post') + ' on this page';
            return `
                <section class="post-group">
                    <header class="post-group-header">
                        <div>
                            <h5 class="post-group-title">${escapeHtml(itemName(itemId))}</h5>
                            <div class="text-muted small">${escapeHtml(subtitle)}</div>
                        </div>
                        ${approveAll}
                    </header>
                    ${groupPosts.map(postRowHtml).join('')}
                </section>`;
        }).join('');
        renderSelection();
    }

    function detailHtml(post) {
        const content = post.PostContent || {};
        if (post.Status === 'sent') {
            if (post.Channel === 'email' && content.recipientCount != null) {
                const failed = Array.isArray(content.failedRecipients) ? content.failedRecipients.length : 0;
                return `Sent to ${escapeHtml(plural(content.recipientCount, 'recipient'))}${failed ? `, ${failed} failed` : ''}`;
            }
            if (post.Channel === 'facebook' && post.PlatformPostID) {
                return `<a href="https://www.facebook.com/${encodeURIComponent(post.PlatformPostID)}" target="_blank" rel="noopener">View on Facebook</a>`;
            }
            return `Posted to ${escapeHtml(CHANNEL_LABELS[post.Channel] || post.Channel)}`;
        }
        if (post.FailureReason) return escapeHtml(post.FailureReason);
        if (content.dryRun) return 'Dry run: the sender isn’t set up yet';
        return '';
    }

    function postRowHtml(post) {
        const content = post.PostContent || {};
        const actions = [];
        if (post.Status === 'draft') {
            actions.push(`<button type="button" class="btn btn-sm btn-outline-primary" data-action="approve" data-id="${post.ID}">Approve</button>`);
            // AI touch-up assumes one show; a digest rounds up everything.
            if (post.PostType !== 'digest') {
                actions.push(`<button type="button" class="btn btn-sm btn-outline-secondary" data-action="regenerate" data-id="${post.ID}">Regenerate with AI</button>`);
            }
        }
        if (post.Status === 'approved' && post.Channel === 'email') {
            actions.push(`<button type="button" class="btn btn-sm btn-success" data-action="send-now" data-id="${post.ID}">Send Now</button>`);
        }
        if (post.Status === 'draft' || post.Status === 'approved') {
            actions.push(`<button type="button" class="btn btn-sm btn-outline-secondary" data-action="edit" data-id="${post.ID}">Edit</button>`);
        }
        if (post.Status !== 'sent') {
            actions.push(`<button type="button" class="btn btn-sm btn-outline-danger" data-action="delete" data-id="${post.ID}">Delete</button>`);
        }

        const checkbox = post.Status === 'draft'
            ? `<input type="checkbox" class="form-check-input post-select" data-id="${post.ID}" aria-label="Select this post"${selected.has(post.ID) ? ' checked' : ''}>`
            : '';
        const thumb = content.imageUrl
            ? `<img class="post-thumb" src="${escapeAttr(content.imageUrl)}" alt="" loading="lazy">`
            : '<div class="post-thumb post-thumb-empty"></div>';
        const tags = [
            `<span class="channel-badge post-channel">${escapeHtml(CHANNEL_LABELS[post.Channel] || post.Channel)}</span>`,
            post.PostType === 'low_inventory' ? '<span class="channel-badge">Low tickets</span>' : '',
            tab === 'problems' ? `<span class="channel-badge">${escapeHtml(post.Status)}</span>` : '',
            content.aiRegenerated ? '<span class="channel-badge enabled">AI</span>' : ''
        ].join('');
        const detail = detailHtml(post);

        return `
            <article class="post-row">
                <div class="post-check">${checkbox}</div>
                ${thumb}
                <div class="post-body">
                    <div class="post-meta"><strong>${escapeHtml(formatWallClock(post.ScheduledFor))}</strong>${tags}</div>
                    <div class="post-caption">${escapeHtml(content.caption || '')}</div>
                    ${detail ? `<div class="post-detail small text-muted">${detail}</div>` : ''}
                </div>
                <div class="post-actions">${actions.join('')}</div>
            </article>`;
    }

    function renderSelection() {
        const onPage = posts.filter(p => p.Status === 'draft');
        const selectPage = document.getElementById('select-page');
        selectPage.checked = onPage.length > 0 && onPage.every(p => selected.has(p.ID));
        selectPage.disabled = onPage.length === 0;
        document.getElementById('selection-count').textContent = selected.size ? `${plural(selected.size, 'post')} selected` : '';
        document.getElementById('approve-selected-btn').disabled = selected.size === 0;
    }

    // =====================================================
    // APPROVING
    // =====================================================

    async function bulkApprove(body, buttonEl) {
        buttonEl.disabled = true;
        try {
            const response = await fetch(`${API_URL}/api/marketing/posts/approve`, {
                method: 'POST',
                headers: authHeaders(),
                body: JSON.stringify(body)
            });
            const data = await response.json();
            if (!data.success) {
                UIDialogs.showMessage({ type: 'error', title: "Couldn't approve posts", message: data.message || 'The posts could not be approved.' });
                return;
            }
            selected.clear();
            UIDialogs.showMessage({ type: 'success', title: 'Posts approved', message: `${plural(data.approved, 'post')} approved. ${data.approved === 1 ? 'It goes' : 'They go'} out on schedule.` });
            await load();
        } catch (error) {
            console.error('Error approving posts:', error);
            UIDialogs.showMessage({ type: 'error', title: "Couldn't approve posts", message: 'Something went wrong. Please try again.', details: error.message });
        } finally {
            buttonEl.disabled = false;
        }
    }

    async function approveShow(itemId, buttonEl) {
        const drafts = draftCounts[itemId];
        if (!drafts) return;
        const ok = await UIDialogs.showConfirm({
            title: `Approve ${plural(drafts.total, 'post')}?`,
            message: `You're about to approve ${plural(drafts.total, 'draft')} for ${itemName(itemId)} (${channelBreakdown(drafts.byChannel)}), including any not on this page. Each one goes out at its scheduled time.`,
            confirmText: `Approve ${plural(drafts.total, 'Post')}`
        });
        if (ok) await bulkApprove({ squareItemId: itemId }, buttonEl);
    }

    async function approveSelected(buttonEl) {
        const ids = [...selected];
        if (!ids.length) return;
        const ok = await UIDialogs.showConfirm({
            title: `Approve ${plural(ids.length, 'post')}?`,
            message: `You're about to approve the ${plural(ids.length, 'selected post')}. Each one goes out at its scheduled time.`,
            confirmText: `Approve ${plural(ids.length, 'Post')}`
        });
        if (ok) await bulkApprove({ postIds: ids }, buttonEl);
    }

    // The human-review gate for one post.
    async function approvePost(postId, buttonEl) {
        buttonEl.disabled = true;
        try {
            const response = await fetch(`${API_URL}/api/marketing/posts/${postId}/approve`, { method: 'PUT', headers: authHeaders() });
            const data = await response.json();
            if (!data.success) {
                UIDialogs.showMessage({ type: 'error', title: "Couldn't approve post", message: data.message || 'The post could not be approved.' });
                buttonEl.disabled = false;
                return;
            }
            selected.delete(postId);
            await load();
        } catch (error) {
            console.error('Error approving post:', error);
            UIDialogs.showMessage({ type: 'error', title: "Couldn't approve post", message: 'Something went wrong. Please try again.', details: error.message });
            buttonEl.disabled = false;
        }
    }

    // =====================================================
    // OTHER POST ACTIONS (same routes as the Marketing page used)
    // =====================================================

    // One-off AI touch-up for a single draft. Only runs when someone clicks it.
    async function regenerateCaption(postId, buttonEl) {
        buttonEl.disabled = true;
        buttonEl.textContent = 'Regenerating…';
        try {
            const response = await fetch(`${API_URL}/api/marketing/posts/${postId}/regenerate-caption`, { method: 'POST', headers: authHeaders() });
            const data = await response.json();
            if (!data.success) {
                UIDialogs.showMessage({ type: 'error', title: "Couldn't regenerate caption", message: data.message || 'The caption could not be regenerated.' });
                buttonEl.disabled = false;
                buttonEl.textContent = 'Regenerate with AI';
                return;
            }
            await load();
        } catch (error) {
            console.error('Error regenerating caption:', error);
            UIDialogs.showMessage({ type: 'error', title: "Couldn't regenerate caption", message: 'Something went wrong. Please try again.', details: error.message });
            buttonEl.disabled = false;
            buttonEl.textContent = 'Regenerate with AI';
        }
    }

    // Email only: sends right now instead of waiting for the schedule.
    async function sendPostNow(postId, buttonEl) {
        if (!await UIDialogs.showConfirm({ title: 'Send email now?', message: 'This sends the email right now to every active contact on your Email List.', confirmText: 'Send Now', danger: true })) return;

        buttonEl.disabled = true;
        buttonEl.textContent = 'Sending…';
        try {
            const response = await fetch(`${API_URL}/api/marketing/posts/${postId}/send-now`, { method: 'POST', headers: authHeaders() });
            const data = await response.json();
            if (!data.success) {
                UIDialogs.showMessage({ type: 'error', title: "Couldn't send email", message: data.message || 'The email could not be sent.' });
                buttonEl.disabled = false;
                buttonEl.textContent = 'Send Now';
                return;
            }
            UIDialogs.showMessage(data.failed
                ? { type: 'warning', title: 'Email sent, with failures', message: `Sent to ${data.sent} recipient(s). ${data.failed} could not be sent.` }
                : { type: 'success', title: 'Email sent', message: `Sent to ${data.sent} recipient(s).` });
            await load();
        } catch (error) {
            console.error('Error sending post:', error);
            UIDialogs.showMessage({ type: 'error', title: "Couldn't send email", message: 'Something went wrong. Check the Sent tab before trying again, in case some emails went out.', details: error.message });
            buttonEl.disabled = false;
            buttonEl.textContent = 'Send Now';
        }
    }

    async function deletePost(postId) {
        if (!await UIDialogs.showConfirm({ title: 'Delete post?', message: "Delete this post? This can't be undone.", confirmText: 'Delete Post', danger: true })) return;
        try {
            const response = await fetch(`${API_URL}/api/marketing/posts/${postId}`, { method: 'DELETE', headers: authHeaders() });
            const data = await response.json();
            if (!data.success) {
                UIDialogs.showMessage({ type: 'error', title: "Couldn't delete post", message: data.message || 'The post could not be deleted.' });
                return;
            }
            selected.delete(postId);
            await load();
        } catch (error) {
            console.error('Error deleting post:', error);
            UIDialogs.showMessage({ type: 'error', title: "Couldn't delete post", message: 'Something went wrong. Please try again.', details: error.message });
        }
    }

    // ---- Edit post modal ----

    let editPostId = null;
    let editPostImageDataUrl = null; // set only if a replacement file was picked

    function openEditPostModal(postId) {
        const post = posts.find(p => p.ID === postId);
        if (!post) return;
        editPostId = postId;
        editPostImageDataUrl = null;

        document.getElementById('edit-post-caption').value = post.PostContent?.caption || '';
        document.getElementById('edit-post-image-upload').value = '';
        document.getElementById('edit-post-error').classList.add('d-none');

        const imageUrl = post.PostContent?.imageUrl || '';
        const previewEl = document.getElementById('edit-post-image-preview');
        const emptyEl = document.getElementById('edit-post-image-empty');
        previewEl.src = imageUrl;
        previewEl.style.display = imageUrl ? 'block' : 'none';
        emptyEl.style.display = imageUrl ? 'none' : 'block';

        bootstrap.Modal.getOrCreateInstance(document.getElementById('edit-post-modal')).show();
    }

    function handleEditPostImageUpload(event) {
        const file = event.target.files[0];
        if (!file) return;
        if (!file.type.startsWith('image/')) {
            UIDialogs.fieldError(event.target, 'Choose an image file.');
            event.target.value = '';
            return;
        }
        // 4 MB raw: it's base64-encoded into a JSON body (the server resizes
        // it), which has to stay under Lambda's 6 MB request limit.
        if (file.size > 4 * 1024 * 1024) {
            UIDialogs.fieldError(event.target, 'That image is over 4 MB. Choose a smaller one.');
            event.target.value = '';
            return;
        }
        const reader = new FileReader();
        reader.onload = (e) => {
            editPostImageDataUrl = e.target.result;
            const previewEl = document.getElementById('edit-post-image-preview');
            previewEl.src = editPostImageDataUrl;
            previewEl.style.display = 'block';
            document.getElementById('edit-post-image-empty').style.display = 'none';
        };
        reader.readAsDataURL(file);
    }

    async function saveEditPost() {
        const errorEl = document.getElementById('edit-post-error');
        errorEl.classList.add('d-none');
        const saveBtn = document.getElementById('edit-post-save-btn');
        saveBtn.disabled = true;

        const body = { caption: document.getElementById('edit-post-caption').value };
        if (editPostImageDataUrl) body.imageDataUrl = editPostImageDataUrl;

        try {
            const response = await fetch(`${API_URL}/api/marketing/posts/${editPostId}`, {
                method: 'PUT',
                headers: authHeaders(),
                body: JSON.stringify(body)
            });
            const data = await response.json();
            if (!data.success) {
                errorEl.textContent = data.message || 'Could not save changes.';
                errorEl.classList.remove('d-none');
                return;
            }
            bootstrap.Modal.getInstance(document.getElementById('edit-post-modal')).hide();
            await load();
        } catch (error) {
            console.error('Error saving post edit:', error);
            errorEl.textContent = 'Could not save changes.';
            errorEl.classList.remove('d-none');
        } finally {
            saveBtn.disabled = false;
        }
    }

    // =====================================================
    // WIRING
    // =====================================================

    function setTab(name) {
        if (name === tab) return;
        tab = name;
        const url = new URL(window.location.href);
        url.searchParams.set('tab', tab);
        window.history.replaceState(null, '', url);
        reload();
    }

    document.addEventListener('DOMContentLoaded', function() {
        renderTabs();
        loadItems();
        load();

        document.getElementById('posts-tabs').addEventListener('click', (event) => {
            const link = event.target.closest('[data-tab]');
            if (link) setTab(link.dataset.tab);
        });

        document.getElementById('posts-filters').addEventListener('submit', (event) => {
            event.preventDefault();
            reload();
        });
        for (const id of ['filter-item', 'filter-channel', 'filter-from', 'filter-to']) {
            document.getElementById(id).addEventListener('change', reload);
        }
        document.getElementById('filter-clear').addEventListener('click', () => {
            document.getElementById('posts-filters').reset();
            reload();
        });

        document.getElementById('posts-container').addEventListener('click', (event) => {
            const button = event.target.closest('button[data-action]');
            if (!button) return;
            const id = Number(button.dataset.id);
            switch (button.dataset.action) {
                case 'approve-show': return approveShow(button.dataset.item, button);
                case 'approve': return approvePost(id, button);
                case 'regenerate': return regenerateCaption(id, button);
                case 'send-now': return sendPostNow(id, button);
                case 'edit': return openEditPostModal(id);
                case 'delete': return deletePost(id);
            }
        });
        document.getElementById('posts-container').addEventListener('change', (event) => {
            if (!event.target.classList.contains('post-select')) return;
            const id = Number(event.target.dataset.id);
            if (event.target.checked) selected.add(id); else selected.delete(id);
            renderSelection();
        });
        document.getElementById('select-page').addEventListener('change', (event) => {
            for (const post of posts) {
                if (post.Status !== 'draft') continue;
                if (event.target.checked) selected.add(post.ID); else selected.delete(post.ID);
            }
            document.querySelectorAll('.post-select').forEach(box => { box.checked = event.target.checked; });
            renderSelection();
        });
        document.getElementById('approve-selected-btn').addEventListener('click', (event) => approveSelected(event.currentTarget));

        document.getElementById('edit-post-save-btn').addEventListener('click', saveEditPost);
        document.getElementById('edit-post-image-upload').addEventListener('change', handleEditPostImageUpload);
    });
})();
