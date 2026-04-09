import type { JP343UserState } from '../../types';

export function renderFooter(userState: JP343UserState | null): void {
  const el = document.getElementById('dashboardFooter');
  if (!el) return;

  const version = document.createElement('span');
  version.textContent = `jp343 Extension v${browser.runtime.getManifest().version}`;

  const links = document.createElement('div');
  links.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:10px;margin-top:6px;';

  const site = document.createElement('a');
  site.href = 'https://jp343.com/?src=d';
  site.target = '_blank';
  site.textContent = 'jp343.com';
  site.style.cssText = 'color:var(--accent, #e84393);opacity:0.8;font-size:11px;text-decoration:none;transition:opacity 0.2s;';
  site.onmouseover = () => { site.style.opacity = '1'; };
  site.onmouseout = () => { site.style.opacity = '0.8'; };

  const github = document.createElement('a');
  github.href = 'https://github.com/mh-343/jp343-tracker';
  github.target = '_blank';
  github.title = 'Source code on GitHub';
  github.style.cssText = 'color:var(--accent, #e84393);opacity:0.8;transition:opacity 0.2s;display:flex;align-items:center;';
  github.onmouseover = () => { github.style.opacity = '1'; };
  github.onmouseout = () => { github.style.opacity = '0.5'; };
  const ghSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  ghSvg.setAttribute('width', '16');
  ghSvg.setAttribute('height', '16');
  ghSvg.setAttribute('viewBox', '0 0 16 16');
  ghSvg.setAttribute('fill', 'currentColor');
  const ghPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  ghPath.setAttribute('d', 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z');
  ghSvg.appendChild(ghPath);
  github.appendChild(ghSvg);

  const feedbackBtn = document.createElement('button');
  feedbackBtn.className = 'footer-feedback-btn';
  feedbackBtn.title = 'Send feedback or report a bug';
  const envSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  envSvg.setAttribute('width', '14');
  envSvg.setAttribute('height', '14');
  envSvg.setAttribute('viewBox', '0 0 24 24');
  envSvg.setAttribute('fill', 'none');
  envSvg.setAttribute('stroke', 'currentColor');
  envSvg.setAttribute('stroke-width', '2');
  const envPath1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  envPath1.setAttribute('d', 'M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z');
  const envPath2 = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  envPath2.setAttribute('points', '22,6 12,13 2,6');
  envSvg.appendChild(envPath1);
  envSvg.appendChild(envPath2);
  feedbackBtn.appendChild(envSvg);
  const feedbackLabel = document.createElement('span');
  feedbackLabel.textContent = 'Feedback';
  feedbackBtn.appendChild(feedbackLabel);

  feedbackBtn.addEventListener('click', () => openFeedbackModal(userState));

  links.appendChild(github);
  links.appendChild(site);
  links.appendChild(feedbackBtn);
  el.textContent = '';
  el.appendChild(version);
  el.appendChild(links);
}

function openFeedbackModal(userState: JP343UserState | null): void {
  const existing = document.getElementById('feedbackOverlay');
  if (existing) {
    existing.classList.add('open');
    return;
  }

  const isLoggedIn = !!userState?.extApiToken;
  const overlay = document.createElement('div');
  overlay.id = 'feedbackOverlay';
  overlay.className = 'feedback-overlay open';

  const card = document.createElement('div');
  card.className = 'feedback-card';

  const title = document.createElement('h3');
  title.className = 'feedback-title';
  title.textContent = 'Send Feedback';

  const subtitle = document.createElement('p');
  subtitle.className = 'feedback-subtitle';
  subtitle.textContent = 'Help us improve jp343';

  card.appendChild(title);
  card.appendChild(subtitle);

  if (!isLoggedIn) {
    const loginMsg = document.createElement('p');
    loginMsg.style.cssText = 'font-size:13px;color:var(--text-dim);margin:0 0 16px;';
    loginMsg.textContent = 'Log in to send feedback directly, or join our Discord:';
    card.appendChild(loginMsg);

    const discordLink = document.createElement('a');
    discordLink.href = 'https://discord.gg/WxGtd5eNH9';
    discordLink.target = '_blank';
    discordLink.textContent = 'Join Discord';
    discordLink.style.cssText = 'display:inline-block;padding:8px 16px;background:linear-gradient(135deg,var(--magenta),var(--cyan));color:#fff;border-radius:6px;text-decoration:none;font-size:13px;font-weight:600;';
    card.appendChild(discordLink);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'feedback-btn-cancel';
    closeBtn.textContent = 'Close';
    closeBtn.style.cssText += 'margin-top:12px;display:block;';
    closeBtn.addEventListener('click', () => overlay.classList.remove('open'));
    card.appendChild(closeBtn);
  } else {
    const typeLabel = document.createElement('label');
    typeLabel.className = 'feedback-label';
    typeLabel.textContent = 'Type';
    card.appendChild(typeLabel);

    const select = document.createElement('select');
    select.className = 'feedback-select';
    for (const opt of [['bug', 'Bug Report'], ['suggestion', 'Suggestion'], ['other', 'Other']]) {
      const option = document.createElement('option');
      option.value = opt[0];
      option.textContent = opt[1];
      select.appendChild(option);
    }
    card.appendChild(select);

    const msgLabel = document.createElement('label');
    msgLabel.className = 'feedback-label';
    msgLabel.textContent = 'Message';
    card.appendChild(msgLabel);

    const textarea = document.createElement('textarea');
    textarea.className = 'feedback-textarea';
    textarea.maxLength = 500;
    textarea.placeholder = 'Describe the issue or your idea...';
    card.appendChild(textarea);

    const charCount = document.createElement('div');
    charCount.className = 'feedback-char';
    charCount.textContent = '0/500';
    textarea.addEventListener('input', () => {
      charCount.textContent = `${textarea.value.length}/500`;
    });
    card.appendChild(charCount);

    const actions = document.createElement('div');
    actions.className = 'feedback-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'feedback-btn-cancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => overlay.classList.remove('open'));

    const submitBtn = document.createElement('button');
    submitBtn.className = 'feedback-btn-submit';
    submitBtn.textContent = 'Submit';

    const feedbackMsg = document.createElement('div');
    feedbackMsg.className = 'feedback-msg';

    submitBtn.addEventListener('click', async () => {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Sending...';
      feedbackMsg.className = 'feedback-msg';
      feedbackMsg.style.display = 'none';

      try {
        const ajaxUrl = userState?.ajaxUrl || 'https://jp343.com/wp-admin/admin-ajax.php';
        const params = new URLSearchParams({
          action: 'jp343_extension_submit_feedback',
          ext_api_token: userState!.extApiToken!,
          report_type: select.value,
          message: textarea.value.trim(),
          extension_version: browser.runtime.getManifest().version
        });

        const response = await fetch(ajaxUrl, { method: 'POST', credentials: 'include', body: params });
        const data = await response.json();

        if (data.success) {
          feedbackMsg.className = 'feedback-msg success';
          feedbackMsg.textContent = 'Thank you! Your feedback has been submitted.';
          feedbackMsg.style.display = 'block';
          setTimeout(() => {
            overlay.classList.remove('open');
            select.value = 'bug';
            textarea.value = '';
            charCount.textContent = '0/500';
            feedbackMsg.style.display = 'none';
            submitBtn.disabled = false;
            submitBtn.textContent = 'Submit';
          }, 2000);
        } else {
          feedbackMsg.className = 'feedback-msg error';
          feedbackMsg.textContent = data.data?.message || 'Something went wrong';
          feedbackMsg.style.display = 'block';
          submitBtn.disabled = false;
          submitBtn.textContent = 'Submit';
        }
      } catch {
        feedbackMsg.className = 'feedback-msg error';
        feedbackMsg.textContent = 'Network error. Please try again.';
        feedbackMsg.style.display = 'block';
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit';
      }
    });

    actions.appendChild(cancelBtn);
    actions.appendChild(submitBtn);
    card.appendChild(actions);
    card.appendChild(feedbackMsg);
  }

  overlay.appendChild(card);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.classList.remove('open');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.classList.contains('open')) {
      overlay.classList.remove('open');
    }
  });

  document.body.appendChild(overlay);
}
