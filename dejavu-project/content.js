console.log("DejaVu: Action tracker injected.");

// 监听点击事件
document.addEventListener('click', (e) => {
  const log = {
    type: 'click',
    timestamp: Date.now(),
    targetXPath: getXPath(e.target)
  };
  chrome.runtime.sendMessage({ type: 'LOG_ACTION', data: log });
}, true); // 使用捕获阶段以获取所有点击

// 监听输入事件
document.addEventListener('input', (e) => {
  // 避免记录密码
  if (e.target.type === 'password') {
    return;
  }
  const log = {
    type: 'input',
    timestamp: Date.now(),
    targetXPath: getXPath(e.target),
    value: e.target.value
  };
  chrome.runtime.sendMessage({ type: 'LOG_ACTION', data: log });
}, true);

/**
 * 获取元素的 XPath
 * @param {HTMLElement} element 
 * @returns {string}
 */
function getXPath(element) {
  if (element.id !== '') {
    return 'id("' + element.id + '")';
  }
  if (element === document.body) {
    return element.tagName.toLowerCase();
  }

  let ix = 0;
  const siblings = element.parentNode.childNodes;
  for (let i = 0; i < siblings.length; i++) {
    const sibling = siblings[i];
    if (sibling === element) {
      return getXPath(element.parentNode) + '/' + element.tagName.toLowerCase() + '[' + (ix + 1) + ']';
    }
    if (sibling.nodeType === 1 && sibling.tagName === element.tagName) {
      ix++;
    }
  }
}