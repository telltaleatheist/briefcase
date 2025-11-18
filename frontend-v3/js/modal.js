// ============================================================================
// MODAL SYSTEM
// ============================================================================

class ModalSystem {
    constructor() {
        this.activeModal = null;
        this.init();
    }

    init() {
        // Close modal on escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.activeModal) {
                this.close();
            }
        });
    }

    create(options = {}) {
        const defaults = {
            title: 'Modal Title',
            content: 'Modal content goes here',
            size: 'medium', // small, medium, large, fullscreen
            type: '', // success, warning, danger, info
            showClose: true,
            showFooter: true,
            closeOnOverlay: true,
            buttons: [
                { text: 'Cancel', type: 'secondary', action: 'close' },
                { text: 'Confirm', type: 'primary', action: 'close' }
            ]
        };

        const config = { ...defaults, ...options };

        // Create modal HTML
        const modalHtml = `
            <div class="modal-overlay" id="modalOverlay">
                <div class="modal modal-${config.size} ${config.type ? `modal-${config.type}` : ''}">
                    ${config.showClose ? `
                        <div class="modal-header">
                            <h2 class="modal-title">${config.title}</h2>
                            <button class="modal-close" onclick="modalSystem.close()">×</button>
                        </div>
                    ` : ''}
                    <div class="modal-body">
                        ${config.content}
                    </div>
                    ${config.showFooter ? `
                        <div class="modal-footer">
                            ${config.buttons.map((btn, index) => `
                                <button class="modal-btn modal-btn-${btn.type}" 
                                        data-action="${btn.action}" 
                                        data-index="${index}">
                                    ${btn.text}
                                </button>
                            `).join('')}
                        </div>
                    ` : ''}
                </div>
            </div>
        `;

        // Remove any existing modal
        this.close();

        // Add modal to DOM
        document.body.insertAdjacentHTML('beforeend', modalHtml);
        this.activeModal = document.getElementById('modalOverlay');

        // Show modal with animation
        setTimeout(() => {
            this.activeModal.classList.add('active');
        }, 10);

        // Setup event listeners
        this.setupEventListeners(config);
    }

    setupEventListeners(config) {
        if (!this.activeModal) return;

        // Close on overlay click
        if (config.closeOnOverlay) {
            this.activeModal.addEventListener('click', (e) => {
                if (e.target === this.activeModal) {
                    this.close();
                }
            });
        }

        // Button actions
        const buttons = this.activeModal.querySelectorAll('.modal-btn');
        buttons.forEach(btn => {
            btn.addEventListener('click', () => {
                const action = btn.getAttribute('data-action');
                const index = btn.getAttribute('data-index');
                
                if (action === 'close') {
                    this.close();
                } else if (config.buttons[index].callback) {
                    config.buttons[index].callback();
                }
            });
        });
    }

    // Specific modal types
    alert(message, title = 'Alert', type = 'info') {
        this.create({
            title: title,
            content: `<p>${message}</p>`,
            type: type,
            size: 'small',
            buttons: [
                { text: 'OK', type: 'primary', action: 'close' }
            ]
        });
    }

    confirm(message, title = 'Confirm', onConfirm = () => {}, onCancel = () => {}) {
        this.create({
            title: title,
            content: `
                <div class="modal-icon-header">
                    <div class="modal-icon-circle warning">⚠️</div>
                    <p>${message}</p>
                </div>
            `,
            size: 'small',
            buttons: [
                { text: 'Cancel', type: 'secondary', action: 'close', callback: onCancel },
                { text: 'Confirm', type: 'primary', action: 'close', callback: onConfirm }
            ]
        });
    }

    form(title, fields, onSubmit) {
        const formContent = `
            <form id="modalForm">
                ${fields.map(field => `
                    <div class="modal-form-group">
                        <label class="modal-form-label">${field.label}</label>
                        ${field.type === 'textarea' ? 
                            `<textarea class="modal-form-textarea" name="${field.name}" placeholder="${field.placeholder || ''}"></textarea>` :
                            `<input class="modal-form-input" type="${field.type}" name="${field.name}" placeholder="${field.placeholder || ''}">`
                        }
                        ${field.help ? `<div class="modal-form-help">${field.help}</div>` : ''}
                    </div>
                `).join('')}
            </form>
        `;

        this.create({
            title: title,
            content: formContent,
            buttons: [
                { text: 'Cancel', type: 'secondary', action: 'close' },
                { 
                    text: 'Submit', 
                    type: 'primary', 
                    action: 'custom',
                    callback: () => {
                        const form = document.getElementById('modalForm');
                        const formData = new FormData(form);
                        const data = Object.fromEntries(formData);
                        onSubmit(data);
                        this.close();
                    }
                }
            ]
        });
    }

    loading(message = 'Loading...') {
        this.create({
            content: `
                <div class="modal-loading">
                    <div class="modal-spinner"></div>
                    <div class="modal-loading-text">${message}</div>
                </div>
            `,
            showClose: false,
            showFooter: false,
            closeOnOverlay: false,
            size: 'small'
        });
    }

    close() {
        if (this.activeModal) {
            this.activeModal.classList.remove('active');
            setTimeout(() => {
                this.activeModal.remove();
                this.activeModal = null;
            }, 300);
        }
    }
}

// Initialize modal system globally
const modalSystem = new ModalSystem();

// Example usage functions (you can call these from anywhere)
function showInfoModal() {
    modalSystem.alert('This is an informational message that helps users understand something important.', 'Information', 'info');
}

function showConfirmModal() {
    modalSystem.confirm(
        'Are you sure you want to delete this item? This action cannot be undone.',
        'Delete Confirmation',
        () => {
            showNotification('Item deleted successfully!', 'success');
        },
        () => {
            showNotification('Deletion cancelled', 'info');
        }
    );
}

function showFormModal() {
    modalSystem.form(
        'Contact Form',
        [
            { name: 'name', label: 'Your Name', type: 'text', placeholder: 'John Doe' },
            { name: 'email', label: 'Email Address', type: 'email', placeholder: 'john@example.com' },
            { name: 'message', label: 'Message', type: 'textarea', placeholder: 'Your message here...', help: 'Please be as detailed as possible' }
        ],
        (data) => {
            console.log('Form submitted:', data);
            showNotification('Form submitted successfully!', 'success');
        }
    );
}

function showCustomModal() {
    modalSystem.create({
        title: '🎨 Custom Modal Example',
        content: `
            <div style="text-align: center;">
                <p style="font-size: 1.1rem; margin-bottom: 1rem;">This is a custom modal with rich content!</p>
                <div style="background: var(--bg-secondary); padding: 1rem; border-radius: var(--border-radius); margin: 1rem 0;">
                    <h3 style="color: var(--primary-orange); margin-bottom: 0.5rem;">Features Include:</h3>
                    <ul style="text-align: left; list-style: none; padding: 0;">
                        <li>✅ Multiple sizes (small, medium, large, fullscreen)</li>
                        <li>✅ Different types (success, warning, danger, info)</li>
                        <li>✅ Custom buttons with callbacks</li>
                        <li>✅ Form support with validation</li>
                        <li>✅ Loading states</li>
                        <li>✅ Fully responsive</li>
                    </ul>
                </div>
                <p style="color: var(--text-muted); font-size: 0.9rem;">Press ESC to close or click outside the modal</p>
            </div>
        `,
        size: 'medium',
        type: '',
        buttons: [
            { text: 'Close', type: 'secondary', action: 'close' },
            { text: 'Learn More', type: 'primary', action: 'custom', callback: () => {
                modalSystem.alert('You clicked Learn More! This modal system is fully customizable.', 'Success', 'success');
            }}
        ]
    });
}