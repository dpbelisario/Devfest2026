(() => {
  if (window.top !== window || !window.ContourIndoor || document.getElementById('contour-indoor-entry')) return;
  const menu = document.querySelector('#drawer .menu');
  if (!menu) return;
  const item = document.createElement('li');
  const button = document.createElement('button');
  button.id = 'contour-indoor-entry';
  button.type = 'button';
  const label = document.createElement('span');
  const updateLabel = () => {
    const language = (document.documentElement.lang || 'en').split('-')[0];
    label.textContent = ({ja: '屋内ナビゲーション', zh: '室内导航', ko: '실내 내비게이션'})[language] || 'Indoor navigation';
  };
  updateLabel();
  button.appendChild(label);
  button.addEventListener('click', () => window.ContourIndoor.postMessage('open'));
  item.appendChild(button);
  menu.appendChild(item);
  new MutationObserver(updateLabel).observe(document.documentElement, {attributes: true, attributeFilter: ['lang']});
})();
