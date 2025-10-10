// shared.js

const API_URL = '/.netlify/functions/proxy';
let pendingUpdate = { pageId: null, action: null, gateName: null };

function promptForUpdate(pageId, action, gateName = null) {
  pendingUpdate = { pageId, action, gateName };
  const modalTitle = document.getElementById('modalTitle');
  const modalMessage = document.getElementById('modalMessage');
  const passwordModal = document.getElementById('passwordModal');
  const passwordInput = document.getElementById('passwordInput');
  
  if (modalTitle) modalTitle.textContent = `Confirm Action: ${action.replace(/_/g, ' ')}`;
  if (modalMessage) modalMessage.textContent = gateName ? `This will attempt to approve all deliverables for gate: ${gateName}.` : 'Please enter the update password to proceed.';
  
  if (passwordModal) {
    passwordModal.style.display = 'flex';
    setTimeout(() => {
      passwordModal.style.opacity = 1;
      const modalContent = passwordModal.querySelector('.modal-content');
      if (modalContent) modalContent.style.transform = 'scale(1)';
    }, 10);
  }
  if (passwordInput) passwordInput.focus();
}

function cancelUpdate() {
  const passwordModal = document.getElementById('passwordModal');
  const passwordInput = document.getElementById('passwordInput');
  const passwordError = document.getElementById('passwordError');

  if (passwordModal) {
    passwordModal.style.opacity = 0;
    const modalContent = passwordModal.querySelector('.modal-content');
    if (modalContent) modalContent.style.transform = 'scale(0.95)';
    setTimeout(() => { passwordModal.style.display = 'none'; }, 300);
  }
  if (passwordInput) passwordInput.value = '';
  if (passwordError) passwordError.classList.add('hidden');
}

async function executeUpdate() {
  const password = document.getElementById('passwordInput').value;
  const passwordError = document.getElementById('passwordError');
  const updateBtnText = document.getElementById('updateBtnText');
  const updateBtnSpinner = document.getElementById('updateBtnSpinner');
  const executeUpdateBtn = document.getElementById('executeUpdateBtn');

  if (!password) {
      if(passwordError) {
        passwordError.textContent = 'Password cannot be empty.';
        passwordError.classList.remove('hidden');
      }
      return;
  }

  if(updateBtnText) updateBtnText.classList.add('hidden');
  if(updateBtnSpinner) updateBtnSpinner.classList.remove('hidden');
  if(executeUpdateBtn) executeUpdateBtn.disabled = true;

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...pendingUpdate, password }),
    });
    if (response.ok) {
      cancelUpdate();
      // Reload data on success by calling a globally available function
      if (typeof loadData === 'function') {
        const loader = document.getElementById('loader');
        if (loader) loader.style.display = 'block';
        document.getElementById('root')?.remove(); // Clear old content if exists
        loadData();
      }
    } else {
      const err = await response.json();
      throw new Error(err.error || 'Update failed.');
    }
  } catch (error) {
    if(passwordError) {
      passwordError.textContent = error.message;
      passwordError.classList.remove('hidden');
    }
  } finally {
    if(updateBtnText) updateBtnText.classList.remove('hidden');
    if(updateBtnSpinner) updateBtnSpinner.classList.add('hidden');
    if(executeUpdateBtn) executeUpdateBtn.disabled = false;
  }
}