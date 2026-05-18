import type { JP343UserState } from '../../types';

let latestUserState: JP343UserState | null = null;
let feedbackBound = false;
let msgBound = false;
let escapeHandler: ((e: KeyboardEvent) => void) | null = null;

export function renderFooter(userState: JP343UserState | null): void {
  latestUserState = userState;
  const el = document.getElementById('dashboardFooter');
  if (!el) return;

  const version = document.createElement('span');
  version.textContent = `jp343 Extension v${browser.runtime.getManifest().version}`;

  const links = document.createElement('div');
  links.className = 'footer-links';

  const github = document.createElement('a');
  github.href = 'https://github.com/mh-343/jp343-tracker';
  github.target = '_blank';
  github.title = 'Source code on GitHub';
  github.className = 'footer-link-icon';
  const ghSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  ghSvg.setAttribute('width', '16');
  ghSvg.setAttribute('height', '16');
  ghSvg.setAttribute('viewBox', '0 0 16 16');
  ghSvg.setAttribute('fill', 'currentColor');
  const ghPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  ghPath.setAttribute('d', 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z');
  ghSvg.appendChild(ghPath);
  github.appendChild(ghSvg);

  links.appendChild(github);
  el.textContent = '';
  el.appendChild(version);
  el.appendChild(links);

  if (!feedbackBound) {
    const feedbackBtn = document.getElementById('headerFeedbackBtn');
    if (feedbackBtn) {
      feedbackBtn.addEventListener('click', () => openFeedbackModal(latestUserState));
      feedbackBound = true;
    }
  }

  if (!msgBound) {
    const msgBtn = document.getElementById('headerMessageBtn');
    if (msgBtn) {
      msgBtn.addEventListener('click', () => {
        msgBtn.style.display = 'none';
        window.open('https://jp343.com?open_messages=1', '_blank');
      });
      msgBound = true;
    }
  }
}

function openFeedbackModal(userState: JP343UserState | null): void {
  const existing = document.getElementById('feedbackOverlay');
  if (existing) existing.remove();

  const canSubmit = !!userState?.extApiToken;
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
    if (!textarea.value.trim()) {
      feedbackMsg.className = 'feedback-msg error';
      feedbackMsg.textContent = 'Please enter a message.';
      feedbackMsg.style.display = 'block';
      return;
    }
    if (!canSubmit) {
      feedbackMsg.className = 'feedback-msg error';
      feedbackMsg.textContent = 'Please log in to submit feedback.';
      feedbackMsg.style.display = 'block';
      return;
    }

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

  const divider = document.createElement('div');
  divider.className = 'feedback-divider';
  const dividerSpan = document.createElement('span');
  dividerSpan.textContent = 'or';
  divider.appendChild(dividerSpan);
  card.appendChild(divider);

  const discordWrap = document.createElement('div');
  discordWrap.className = 'feedback-discord-wrap';
  const discordLink = document.createElement('a');
  discordLink.href = 'https://discord.gg/B9kG2rGhUf';
  discordLink.target = '_blank';
  discordLink.className = 'feedback-discord-link';
  const discordSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  discordSvg.setAttribute('width', '16');
  discordSvg.setAttribute('height', '12');
  discordSvg.setAttribute('viewBox', '0 0 127.14 96.36');
  discordSvg.setAttribute('fill', 'currentColor');
  const discordPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  discordPath.setAttribute('d', 'M107.7,8.07A105.15,105.15,0,0,0,81.47,0a72.06,72.06,0,0,0-3.36,6.83A97.68,97.68,0,0,0,49,6.83,72.37,72.37,0,0,0,45.64,0,105.89,105.89,0,0,0,19.39,8.09C2.79,32.65-1.71,56.6.54,80.21h0A105.73,105.73,0,0,0,32.71,96.36,77.7,77.7,0,0,0,39.6,85.25a68.42,68.42,0,0,1-10.85-5.18c.91-.66,1.8-1.34,2.66-2a75.57,75.57,0,0,0,64.32,0c.87.71,1.76,1.39,2.66,2a68.68,68.68,0,0,1-10.87,5.19,77,77,0,0,0,6.89,11.1A105.25,105.25,0,0,0,126.6,80.22h0C129.24,52.84,122.09,29.11,107.7,8.07ZM42.45,65.69C36.18,65.69,31,60,31,53s5-12.74,11.43-12.74S54,46,53.89,53,48.84,65.69,42.45,65.69Zm42.24,0C78.41,65.69,73.25,60,73.25,53s5-12.74,11.44-12.74S96.23,46,96.12,53,91.08,65.69,84.69,65.69Z');
  discordSvg.appendChild(discordPath);
  discordLink.appendChild(discordSvg);
  discordLink.appendChild(document.createTextNode('Join our Discord'));
  discordWrap.appendChild(discordLink);
  card.appendChild(discordWrap);

  overlay.appendChild(card);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.classList.remove('open');
  });
  if (escapeHandler) document.removeEventListener('keydown', escapeHandler);
  escapeHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && overlay.classList.contains('open')) {
      overlay.classList.remove('open');
    }
  };
  document.addEventListener('keydown', escapeHandler);

  document.body.appendChild(overlay);
}
