/**
 * OWEN MORGAN WEBSITE - COMPLETE JAVASCRIPT FUNCTIONALITY
 * All interactive features and component behaviors
 */

// ============================================================================
// CORE INITIALIZATION
// ============================================================================

document.addEventListener('DOMContentLoaded', function() {
    console.log('🎓 Owen Morgan Website - JavaScript Loaded');
    initializeWebsite();
});

function initializeWebsite() {
    initializeTheme();
    initializeNavigation();
    initializeInteractivity();
    initializeAccessibility();
    initializePageSpecific();
    initializeNewComponents();
    
    trackEvent('page_loaded', {
        page: document.body.getAttribute('data-page') || 'unknown',
        timestamp: new Date().toISOString()
    });
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function trackEvent(eventName, eventData = {}) {
    // Analytics tracking function
    console.debug('[Analytics]', eventName, eventData);
    
    // You can integrate with Google Analytics, Mixpanel, etc.
    if (typeof gtag !== 'undefined') {
        gtag('event', eventName, eventData);
    }
}

function showNotification(message, type = 'info', duration = 3000) {
    // Remove any existing notifications
    const existingNotifications = document.querySelectorAll('.notification');
    existingNotifications.forEach(n => n.remove());
    
    // Create new notification
    const notification = document.createElement('div');
    notification.className = `notification ${type}`;
    notification.textContent = message;
    
    // Style the notification
    Object.assign(notification.style, {
        position: 'fixed',
        top: '20px',
        right: '20px',
        padding: '1rem 1.5rem',
        borderRadius: '8px',
        color: 'white',
        fontWeight: '600',
        zIndex: '9999',
        boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.1)',
        transition: 'all 0.3s ease',
        opacity: '0',
        transform: 'translateY(-10px)'
    });
    
    // Set background color based on type
    const backgrounds = {
        success: '#22c55e',
        error: '#ef4444',
        warning: '#f59e0b',
        info: '#ff6b35'
    };
    notification.style.background = backgrounds[type] || backgrounds.info;
    
    // Add to DOM
    document.body.appendChild(notification);
    
    // Animate in
    setTimeout(() => {
        notification.style.opacity = '1';
        notification.style.transform = 'translateY(0)';
    }, 10);
    
    // Remove after duration
    setTimeout(() => {
        notification.style.opacity = '0';
        notification.style.transform = 'translateY(-10px)';
        setTimeout(() => notification.remove(), 300);
    }, duration);
}

// ============================================================================
// THEME MANAGEMENT
// ============================================================================

function initializeTheme() {
    const savedTheme = localStorage.getItem('theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const theme = savedTheme || (prefersDark ? 'dark' : 'light');
    
    setTheme(theme);
    
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
        if (!localStorage.getItem('theme')) {
            setTheme(e.matches ? 'dark' : 'light');
        }
    });
}

function toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    setTheme(newTheme);
    localStorage.setItem('theme', newTheme);
    
    trackEvent('theme_changed', { new_theme: newTheme });
    showNotification(`Switched to ${newTheme} mode`, 'success', 2000);
}

function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    
    const themeIcon = document.querySelector('.theme-icon');
    if (themeIcon) {
        themeIcon.textContent = theme === 'dark' ? '☀️' : '🌙';
    }
}

// ============================================================================
// NAVIGATION
// ============================================================================

function initializeNavigation() {
    const themeToggle = document.getElementById('themeToggle');
    if (themeToggle) {
        themeToggle.addEventListener('click', toggleTheme);
    }

    const mobileMenuBtn = document.querySelector('.mobile-menu-btn');
    if (mobileMenuBtn) {
        mobileMenuBtn.addEventListener('click', toggleMobileMenu);
    }

    // Smooth scrolling for anchor links
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function (e) {
            e.preventDefault();
            const targetId = this.getAttribute('href');
            if (targetId === '#') return;
            
            const target = document.querySelector(targetId);
            if (target) {
                target.scrollIntoView({
                    behavior: 'smooth',
                    block: 'start'
                });
                closeMobileMenu();
            }
        });
    });

    // Close mobile menu when clicking outside
    document.addEventListener('click', function(e) {
        const navLinks = document.getElementById('navLinks');
        const menuBtn = document.querySelector('.mobile-menu-btn');
        
        if (navLinks && menuBtn && 
            !navLinks.contains(e.target) && 
            !menuBtn.contains(e.target)) {
            navLinks.classList.remove('active');
        }
    });

    // Close mobile menu on Escape key
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            closeMobileMenu();
        }
    });
}

function toggleMobileMenu() {
    const navLinks = document.getElementById('navLinks');
    if (navLinks) {
        navLinks.classList.toggle('active');
    }
}

function closeMobileMenu() {
    const navLinks = document.getElementById('navLinks');
    if (navLinks) {
        navLinks.classList.remove('active');
    }
}

// ============================================================================
// ACCESSIBILITY
// ============================================================================

function initializeAccessibility() {
    // Add keyboard navigation support
    document.addEventListener('keydown', function(e) {
        // Tab navigation improvements
        if (e.key === 'Tab') {
            document.body.classList.add('keyboard-nav');
        }
    });
    
    document.addEventListener('mousedown', function() {
        document.body.classList.remove('keyboard-nav');
    });
    
    // Skip to main content link
    const skipLink = document.createElement('a');
    skipLink.href = '#main-content';
    skipLink.className = 'skip-to-main';
    skipLink.textContent = 'Skip to main content';
    skipLink.style.cssText = `
        position: absolute;
        top: -40px;
        left: 0;
        background: var(--primary-orange);
        color: white;
        padding: 8px;
        text-decoration: none;
        z-index: 100;
    `;
    
    skipLink.addEventListener('focus', function() {
        this.style.top = '0';
    });
    
    skipLink.addEventListener('blur', function() {
        this.style.top = '-40px';
    });
    
    document.body.insertBefore(skipLink, document.body.firstChild);
    
    // Add ARIA labels where needed
    const navElement = document.querySelector('.navbar');
    if (navElement) navElement.setAttribute('role', 'navigation');
    
    const mainElement = document.querySelector('main') || document.querySelector('.hero-section');
    if (mainElement) mainElement.setAttribute('role', 'main');
}

// ============================================================================
// SCROLL EFFECTS
// ============================================================================

function initializeScrollEffects() {
    // Parallax scrolling
    const parallaxElements = document.querySelectorAll('[data-parallax]');
    
    if (parallaxElements.length > 0) {
        window.addEventListener('scroll', () => {
            const scrolled = window.pageYOffset;
            
            parallaxElements.forEach(element => {
                const speed = element.dataset.parallax || 0.5;
                const yPos = -(scrolled * speed);
                element.style.transform = `translateY(${yPos}px)`;
            });
        });
    }
    
    // Reveal on scroll
    const revealElements = document.querySelectorAll('.reveal-on-scroll');
    
    if (revealElements.length > 0) {
        const revealObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    entry.target.classList.add('revealed');
                }
            });
        }, { threshold: 0.1 });
        
        revealElements.forEach(element => {
            revealObserver.observe(element);
        });
    }
    
    // Sticky header behavior
    let lastScroll = 0;
    const navbar = document.querySelector('.navbar');
    
    if (navbar) {
        window.addEventListener('scroll', () => {
            const currentScroll = window.pageYOffset;
            
            if (currentScroll > lastScroll && currentScroll > 100) {
                navbar.style.transform = 'translateY(-100%)';
            } else {
                navbar.style.transform = 'translateY(0)';
            }
            
            lastScroll = currentScroll;
        });
    }
}

// ============================================================================
// PARALLAX EFFECTS
// ============================================================================

function initializeParallax() {
    const parallaxElements = document.querySelectorAll('.parallax');
    
    if (parallaxElements.length === 0) return;
    
    window.addEventListener('scroll', () => {
        const scrolled = window.pageYOffset;
        
        parallaxElements.forEach(element => {
            const speed = element.dataset.speed || 0.5;
            const yPos = -(scrolled * speed);
            element.style.transform = `translateY(${yPos}px)`;
        });
    });
}

// ============================================================================
// INTERACTIVITY AND ANIMATIONS
// ============================================================================

function initializeInteractivity() {
    // Add click feedback to all interactive elements
    document.querySelectorAll('.card, .tile, .panel, .stat-card, .mini-card, .feature-box').forEach(element => {
        element.addEventListener('click', function(e) {
            addClickFeedback(this);
            trackElementClick(this);
        });
    });

    initializeScrollEffects();
    initializeComponentInteractions();
}

function addClickFeedback(element) {
    element.style.transform = 'scale(0.98)';
    setTimeout(() => {
        element.style.transform = '';
    }, 150);
}

function trackElementClick(element) {
    const title = getElementTitle(element);
    const type = getElementType(element);
    
    trackEvent('element_clicked', {
        type: type,
        title: title,
        timestamp: new Date().toISOString()
    });
}

function getElementTitle(element) {
    const titleSelectors = [
        '.card-title', '.tile-title', '.panel-title', 
        '.stat-label', '.mini-card-title', '.feature-box-title'
    ];
    
    for (const selector of titleSelectors) {
        const titleElement = element.querySelector(selector);
        if (titleElement) {
            return titleElement.textContent.trim();
        }
    }
    
    const title = element.getAttribute('data-title') || element.getAttribute('title');
    if (title) {
        return title;
    }
    
    const text = element.textContent.trim();
    return text.length > 50 ? text.substring(0, 50) + '...' : text;
}

function getElementType(element) {
    const types = ['card', 'tile', 'panel', 'stat-card', 'mini-card', 'feature-box', 'timeline-item'];
    for (const type of types) {
        if (element.classList.contains(type)) return type;
    }
    return 'unknown';
}

// ============================================================================
// NEW COMPONENT INTERACTIONS
// ============================================================================

function initializeNewComponents() {
    initializeTiles();
    initializePanels();
    initializeStatCards();
    initializeTimeline();
    initializeBadges();
    initializeMiniCards();
    initializeFeatureBoxes();
    initializeFileUploads();
    initializeProgressIndicators();
    initializeDataTables();
    initializeAlerts();
    initializeWidgets();
    initializeInteractiveCards();
    initializeComparisonTables();
    initializeTagClouds();
    initializeAccordion();
    initializeModalCards();
    initializeRatingSystems();
    initializeSidebarNavigation();
    initializeBreadcrumbs();
    initializeFloatingActionButtons();
}

function initializeTiles() {
    document.querySelectorAll('.tile').forEach(tile => {
        tile.addEventListener('mouseenter', function() {
            const icon = this.querySelector('.tile-icon');
            if (icon) {
                icon.style.transform = 'scale(1.2) rotate(5deg)';
            }
        });
        
        tile.addEventListener('mouseleave', function() {
            const icon = this.querySelector('.tile-icon');
            if (icon) {
                icon.style.transform = '';
            }
        });
    });
}

function initializePanels() {
    document.querySelectorAll('.panel').forEach(panel => {
        const header = panel.querySelector('.panel-header');
        if (header) {
            header.style.cursor = 'pointer';
            header.addEventListener('click', function() {
                const content = panel.querySelector('.panel-content');
                if (content) {
                    const isHidden = content.style.display === 'none';
                    content.style.display = isHidden ? 'block' : 'none';
                    showNotification(`Panel ${isHidden ? 'expanded' : 'collapsed'}`, 'info', 1500);
                }
            });
        }
    });
}

function initializeStatCards() {
    document.querySelectorAll('.stat-card').forEach(card => {
        card.addEventListener('mouseenter', function() {
            animateCounter(this);
        });
    });
}

function animateCounter(card) {
    const numberElement = card.querySelector('.stat-number');
    if (!numberElement || numberElement.dataset.animated === 'true') return;
    
    const finalValue = numberElement.textContent;
    const numericValue = parseInt(finalValue.replace(/\D/g, ''));
    
    if (isNaN(numericValue)) return;
    
    numberElement.dataset.animated = 'true';
    
    let currentValue = 0;
    const increment = Math.ceil(numericValue / 30);
    const timer = setInterval(() => {
        currentValue += increment;
        if (currentValue >= numericValue) {
            currentValue = numericValue;
            clearInterval(timer);
        }
        
        if (finalValue.includes('%')) {
            numberElement.textContent = currentValue + '%';
        } else {
            numberElement.textContent = currentValue.toLocaleString();
        }
    }, 50);
}

function initializeTimeline() {
    const timelineItems = document.querySelectorAll('.timeline-item');
    
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.style.opacity = '1';
                entry.target.style.transform = 'translateX(0)';
            }
        });
    }, { threshold: 0.5 });
    
    timelineItems.forEach((item, index) => {
        item.style.opacity = '0';
        item.style.transform = 'translateX(-20px)';
        item.style.transition = 'all 0.6s ease';
        item.style.transitionDelay = `${index * 0.1}s`;
        
        observer.observe(item);
    });
}

function initializeBadges() {
    document.querySelectorAll('.badge').forEach(badge => {
        badge.addEventListener('click', function() {
            const text = this.textContent;
            showNotification(`Selected: ${text}`, 'info', 2000);
            
            this.style.transform = 'scale(0.95)';
            setTimeout(() => {
                this.style.transform = '';
            }, 150);
        });
    });
}

function initializeMiniCards() {
    document.querySelectorAll('.mini-card').forEach(card => {
        card.addEventListener('mouseenter', function() {
            const icon = this.querySelector('.mini-card-icon');
            if (icon) {
                icon.style.transform = 'scale(1.1)';
            }
        });
        
        card.addEventListener('mouseleave', function() {
            const icon = this.querySelector('.mini-card-icon');
            if (icon) {
                icon.style.transform = '';
            }
        });
    });
}

function initializeFeatureBoxes() {
    document.querySelectorAll('.feature-box').forEach(box => {
        const listItems = box.querySelectorAll('.feature-box-list li');
        
        box.addEventListener('mouseenter', function() {
            listItems.forEach((item, index) => {
                setTimeout(() => {
                    item.style.transform = 'translateX(5px)';
                    item.style.color = 'var(--primary-orange)';
                }, index * 100);
            });
        });
        
        box.addEventListener('mouseleave', function() {
            listItems.forEach(item => {
                item.style.transform = '';
                item.style.color = '';
            });
        });
    });
}

function initializeComponentInteractions() {
    // Classification scale interactions
    document.querySelectorAll('.scale-item').forEach(item => {
        item.addEventListener('click', function() {
            document.querySelectorAll('.scale-item').forEach(scale => {
                scale.classList.remove('selected');
            });
            
            this.classList.add('selected');
            
            const level = this.querySelector('.scale-number').textContent;
            const label = this.querySelector('.scale-label').textContent;
            
            showNotification(`Selected ${label} (Level ${level})`, 'info', 2000);
            trackEvent('classification_selected', { level, label });
        });
    });
    
    initializeParallax();
}

// ============================================================================
// FILE UPLOAD FUNCTIONALITY
// ============================================================================

function initializeFileUploads() {
    document.querySelectorAll('.upload-zone').forEach(zone => {
        const input = zone.querySelector('.upload-input');
        
        zone.addEventListener('click', () => {
            input.click();
        });
        
        zone.addEventListener('dragover', (e) => {
            e.preventDefault();
            zone.classList.add('drag-over');
        });
        
        zone.addEventListener('dragleave', (e) => {
            e.preventDefault();
            zone.classList.remove('drag-over');
        });
        
        zone.addEventListener('drop', (e) => {
            e.preventDefault();
            zone.classList.remove('drag-over');
            handleFileUpload(e.dataTransfer.files, zone);
        });
        
        input.addEventListener('change', (e) => {
            handleFileUpload(e.target.files, zone);
        });
    });
}

function handleFileUpload(files, zone) {
    const fileList = Array.from(files);
    const zoneType = zone.classList.contains('image-upload') ? 'image' : 
                     zone.classList.contains('data-upload') ? 'data' : 'document';
    
    showNotification(`Uploaded ${fileList.length} ${zoneType} file(s)`, 'success', 3000);
    
    const icon = zone.querySelector('.upload-icon');
    const originalIcon = icon.textContent;
    icon.textContent = '✅';
    
    setTimeout(() => {
        icon.textContent = originalIcon;
    }, 2000);
    
    trackEvent('files_uploaded', {
        count: fileList.length,
        type: zoneType,
        files: fileList.map(f => ({ name: f.name, size: f.size }))
    });
}

// ============================================================================
// PROGRESS INDICATORS
// ============================================================================

function initializeProgressIndicators() {
    const circularProgress = document.querySelectorAll('.circular-progress');
    
    const progressObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                animateCircularProgress(entry.target);
            }
        });
    }, { threshold: 0.5 });
    
    circularProgress.forEach(progress => {
        progressObserver.observe(progress);
    });
    
    document.querySelectorAll('.step').forEach(step => {
        step.addEventListener('click', function() {
            const title = this.querySelector('.step-title').textContent;
            showNotification(`Step: ${title}`, 'info', 2000);
        });
    });
}

function animateCircularProgress(element) {
    const progress = parseInt(element.dataset.progress) || 0;
    const angle = (progress / 100) * 360;
    
    element.style.background = `conic-gradient(
        var(--primary-orange) 0deg,
        var(--primary-orange) ${angle}deg,
        var(--bg-tertiary) ${angle}deg,
        var(--bg-tertiary) 360deg
    )`;
}

// ============================================================================
// DATA TABLES
// ============================================================================

function initializeDataTables() {
    document.querySelectorAll('.data-table').forEach(table => {
        const headers = table.querySelectorAll('th.sortable');
        
        headers.forEach(header => {
            header.addEventListener('click', function() {
                sortTable(table, this);
            });
        });
        
        const rows = table.querySelectorAll('tbody tr');
        rows.forEach(row => {
            row.addEventListener('click', function() {
                const orgName = this.cells[0].textContent;
                showNotification(`Selected: ${orgName}`, 'info', 2000);
                
                rows.forEach(r => r.classList.remove('selected'));
                this.classList.add('selected');
            });
        });
    });
}

function sortTable(table, header) {
    const tbody = table.querySelector('tbody');
    const rows = Array.from(tbody.querySelectorAll('tr'));
    const columnIndex = Array.from(header.parentNode.children).indexOf(header);
    const isAscending = header.classList.contains('sort-asc');
    
    table.querySelectorAll('th').forEach(th => {
        th.classList.remove('sort-asc', 'sort-desc');
    });
    
    rows.sort((a, b) => {
        const aValue = a.cells[columnIndex].textContent.trim();
        const bValue = b.cells[columnIndex].textContent.trim();
        
        const aNum = parseFloat(aValue.replace(/[^\d.-]/g, ''));
        const bNum = parseFloat(bValue.replace(/[^\d.-]/g, ''));
        
        if (!isNaN(aNum) && !isNaN(bNum)) {
            return isAscending ? bNum - aNum : aNum - bNum;
        } else {
            return isAscending ? bValue.localeCompare(aValue) : aValue.localeCompare(bValue);
        }
    });
    
    header.classList.add(isAscending ? 'sort-desc' : 'sort-asc');
    
    rows.forEach(row => tbody.appendChild(row));
    
    showNotification(`Sorted by ${header.textContent.replace('↕', '').trim()}`, 'info', 2000);
}

// ============================================================================
// ALERT BANNERS
// ============================================================================

function initializeAlerts() {
    document.querySelectorAll('.alert-close').forEach(closeBtn => {
        closeBtn.addEventListener('click', function() {
            const alert = this.closest('.alert');
            alert.style.transform = 'translateX(100%)';
            alert.style.opacity = '0';
            
            setTimeout(() => {
                alert.remove();
            }, 300);
        });
    });
    
    // Auto-dismiss info alerts
    document.querySelectorAll('.alert.info').forEach(alert => {
        setTimeout(() => {
            const closeBtn = alert.querySelector('.alert-close');
            if (closeBtn && alert.parentNode) {
                closeBtn.click();
            }
        }, 8000);
    });
}

// ============================================================================
// DASHBOARD WIDGETS
// ============================================================================

function initializeWidgets() {
    document.querySelectorAll('.widget-menu').forEach(menu => {
        menu.addEventListener('click', function() {
            const widget = this.closest('.widget');
            const title = widget.querySelector('.widget-title').textContent;
            showNotification(`Widget menu: ${title}`, 'info', 2000);
        });
    });
    
    document.querySelectorAll('.chart-bar').forEach(bar => {
        bar.addEventListener('mouseenter', function() {
            this.style.transform = 'scaleY(1.1)';
            this.style.filter = 'brightness(1.1)';
        });
        
        bar.addEventListener('mouseleave', function() {
            this.style.transform = '';
            this.style.filter = '';
        });
        
        bar.addEventListener('click', function() {
            const label = this.querySelector('.chart-label').textContent;
            const value = this.querySelector('.chart-value').textContent;
            showNotification(`${label}: ${value} organizations`, 'info', 2000);
        });
    });
    
    document.querySelectorAll('.activity-item').forEach(item => {
        item.addEventListener('click', function() {
            const title = this.querySelector('.activity-title').textContent;
            showNotification(`Activity: ${title}`, 'info', 2000);
        });
    });
    
    document.querySelectorAll('.metric').forEach(metric => {
        metric.addEventListener('click', function() {
            const label = this.querySelector('.metric-label').textContent;
            const value = this.querySelector('.metric-value').textContent;
            showNotification(`${label}: ${value}`, 'info', 2000);
        });
    });
}

// Continue with remaining functions...
// [The rest of the functions from your original code remain the same]

// ============================================================================
// INTERACTIVE CARDS
// ============================================================================

function initializeInteractiveCards() {
    document.querySelectorAll('.interactive-card').forEach(card => {
        const expandBtn = card.querySelector('[data-action="expand"]');
        const shareBtn = card.querySelector('[data-action="share"]');
        const bookmarkBtn = card.querySelector('[data-action="bookmark"]');
        const expandedContent = card.querySelector('.card-expanded-content');
        
        if (expandBtn && expandedContent) {
            expandBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                
                if (expandedContent.classList.contains('expanded')) {
                    expandedContent.classList.remove('expanded');
                    expandedContent.style.display = 'none';
                    this.textContent = '📖';
                } else {
                    expandedContent.style.display = 'block';
                    expandedContent.classList.add('expanded');
                    this.textContent = '📕';
                }
            });
        }
        
        if (shareBtn) {
            shareBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                const title = card.querySelector('.card-title').textContent;
                showNotification(`Shared: ${title}`, 'success', 2000);
            });
        }
        
        if (bookmarkBtn) {
            bookmarkBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                const title = card.querySelector('.card-title').textContent;
                const isBookmarked = this.textContent === '🔖';
                
                this.textContent = isBookmarked ? '📑' : '🔖';
                showNotification(
                    `${isBookmarked ? 'Removed bookmark' : 'Bookmarked'}: ${title}`, 
                    'success', 
                    2000
                );
            });
        }
    });
}

// ============================================================================
// COMPARISON TABLES
// ============================================================================

function initializeComparisonTables() {
    document.querySelectorAll('.comparison-table').forEach(table => {
        const rows = table.querySelectorAll('tbody tr');
        
        rows.forEach(row => {
            row.addEventListener('click', function() {
                const feature = this.querySelector('.feature-cell').textContent;
                showNotification(`Comparing: ${feature}`, 'info', 2000);
                
                rows.forEach(r => r.classList.remove('highlighted'));
                this.classList.add('highlighted');
            });
        });
    });
}

// ============================================================================
// TAG CLOUDS
// ============================================================================

function initializeTagClouds() {
    document.querySelectorAll('.tag').forEach(tag => {
        tag.addEventListener('click', function() {
            const tagText = this.textContent;
            const tagType = this.classList.contains('warning') ? 'Warning Sign' : 'Healthy Indicator';
            
            showNotification(`${tagType}: ${tagText}`, 'info', 2000);
            
            this.style.transform = 'scale(0.95)';
            setTimeout(() => {
                this.style.transform = '';
            }, 150);
            
            trackEvent('tag_clicked', {
                tag: tagText,
                type: tagType
            });
        });
        
        tag.addEventListener('mouseenter', function() {
            this.style.transform = 'translateY(-2px) scale(1.05)';
        });
        
        tag.addEventListener('mouseleave', function() {
            this.style.transform = '';
        });
    });
}

// ============================================================================
// ACCORDION
// ============================================================================

function initializeAccordion() {
    document.querySelectorAll('.accordion-item').forEach(item => {
        const header = item.querySelector('.accordion-header');
        const content = item.querySelector('.accordion-content');
        
        header.addEventListener('click', function() {
            const isActive = this.classList.contains('active');
            
            // Close all accordion items
            document.querySelectorAll('.accordion-header').forEach(h => {
                h.classList.remove('active');
            });
            document.querySelectorAll('.accordion-content').forEach(c => {
                c.classList.remove('active');
            });
            
            // Open clicked item if it wasn't already open
            if (!isActive) {
                this.classList.add('active');
                content.classList.add('active');
                
                const title = this.querySelector('.accordion-title').textContent;
                trackEvent('accordion_opened', { title });
            }
        });
    });
    
    // Auto-open first accordion item
    const firstHeader = document.querySelector('.accordion-header');
    if (firstHeader) {
        setTimeout(() => {
            firstHeader.click();
        }, 500);
    }
}

// ============================================================================
// MODAL CARDS
// ============================================================================

function initializeModalCards() {
    document.querySelectorAll('.modal-card').forEach(card => {
        card.addEventListener('click', function() {
            const modalType = this.dataset.modal;
            const title = this.querySelector('.modal-card-title').textContent;
            
            createModal(modalType, title);
            
            trackEvent('modal_opened', {
                type: modalType,
                title: title
            });
        });
    });
}

function createModal(type, title) {
    // Remove any existing modals
    document.querySelectorAll('.modal-overlay').forEach(modal => {
        modal.remove();
    });
    
    const modalOverlay = document.createElement('div');
    modalOverlay.className = 'modal-overlay';
    
    const modalContent = getModalContent(type, title);
    
    modalOverlay.innerHTML = `
        <div class="modal-dialog">
            <div class="modal-header">
                <h3 class="modal-title">${title}</h3>
                <button class="modal-close">&times;</button>
            </div>
            <div class="modal-body">
                ${modalContent}
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary modal-close-btn">Close</button>
                <button class="btn btn-primary">Learn More</button>
            </div>
        </div>
    `;
    
    // Style the modal
    Object.assign(modalOverlay.style, {
        position: 'fixed',
        top: '0',
        left: '0',
        width: '100%',
        height: '100%',
        background: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: '10000',
        backdropFilter: 'blur(4px)'
    });
    
    // Style the modal dialog
    const dialog = modalOverlay.querySelector('.modal-dialog');
    Object.assign(dialog.style, {
        background: 'var(--bg-card)',
        borderRadius: 'var(--border-radius)',
        boxShadow: 'var(--shadow-xl)',
        maxWidth: '600px',
        width: '90%',
        maxHeight: '80vh',
        overflow: 'auto'
    });
    
    // Style modal header
    const header = modalOverlay.querySelector('.modal-header');
    Object.assign(header.style, {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '1.5rem',
        borderBottom: '1px solid var(--border-color)'
    });
    
    // Style modal body
    const body = modalOverlay.querySelector('.modal-body');
    Object.assign(body.style, {
        padding: '1.5rem',
        color: 'var(--text-primary)'
    });
    
    // Style modal footer
    const footer = modalOverlay.querySelector('.modal-footer');
    Object.assign(footer.style, {
        display: 'flex',
        justifyContent: 'flex-end',
        gap: '1rem',
        padding: '1.5rem',
        borderTop: '1px solid var(--border-color)'
    });
    
    // Style buttons
    modalOverlay.querySelectorAll('button').forEach(btn => {
        Object.assign(btn.style, {
            padding: '0.5rem 1rem',
            borderRadius: 'var(--border-radius)',
            cursor: 'pointer',
            fontWeight: '600',
            transition: 'var(--transition)'
        });
    });
    
    modalOverlay.querySelector('.modal-close').style.cssText = `
        background: none;
        border: none;
        fontSize: 1.5rem;
        color: var(--text-muted);
    `;
    
    modalOverlay.querySelector('.btn-primary').style.cssText = `
        background: var(--primary-orange);
        color: white;
        border: none;
    `;
    
    modalOverlay.querySelector('.btn-secondary').style.cssText = `
        background: var(--bg-secondary);
        color: var(--text-primary);
        border: 1px solid var(--border-color);
    `;
    
    document.body.appendChild(modalOverlay);
    
    // Event listeners
    modalOverlay.addEventListener('click', (e) => {
        if (e.target === modalOverlay) {
            modalOverlay.remove();
        }
    });
    
    modalOverlay.querySelectorAll('.modal-close, .modal-close-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            modalOverlay.remove();
        });
    });
    
    // ESC key to close
    document.addEventListener('keydown', function escHandler(e) {
        if (e.key === 'Escape') {
            modalOverlay.remove();
            document.removeEventListener('keydown', escHandler);
        }
    });
}

function getModalContent(type, title) {
    const modalContent = {
        'group-analysis': `
            <h4>Our Comprehensive Analysis Process</h4>
            <p>We use a multi-stage approach to evaluate organizations:</p>
            <ol>
                <li><strong>Data Collection:</strong> Gathering information from multiple sources</li>
                <li><strong>BITE Model Application:</strong> Systematic evaluation of control mechanisms</li>
                <li><strong>Expert Review:</strong> Assessment by qualified professionals</li>
                <li><strong>Peer Validation:</strong> Cross-checking with academic partners</li>
                <li><strong>Classification Assignment:</strong> Determining appropriate risk level</li>
            </ol>
            <p>This process ensures accuracy and objectivity in our assessments.</p>
        `,
        'safety-guidelines': `
            <h4>Essential Safety Considerations</h4>
            <div class="safety-tips">
                <div class="safety-tip">
                    <strong>🔒 Privacy:</strong> Use secure, private devices for research
                </div>
                <div class="safety-tip">
                    <strong>🤫 Discretion:</strong> Be cautious about who you share doubts with
                </div>
                <div class="safety-tip">
                    <strong>📱 Communication:</strong> Maintain outside relationships and support
                </div>
                <div class="safety-tip">
                    <strong>💰 Finances:</strong> Maintain control of your financial resources
                </div>
                <div class="safety-tip">
                    <strong>📄 Documents:</strong> Keep important documents accessible
                </div>
            </div>
        `,
        'support-resources': `
            <h4>Available Support Networks</h4>
            <div class="support-categories">
                <div class="support-category">
                    <h5>Professional Help</h5>
                    <ul>
                        <li>Licensed therapists specializing in cult recovery</li>
                        <li>Exit counselors and intervention specialists</li>
                        <li>Legal professionals familiar with religious freedom</li>
                    </ul>
                </div>
                <div class="support-category">
                    <h5>Peer Support</h5>
                    <ul>
                        <li>Online support groups and forums</li>
                        <li>Local meetups and support circles</li>
                        <li>Mentorship programs with former members</li>
                    </ul>
                </div>
            </div>
        `
    };
    
    return modalContent[type] || '<p>Content not available.</p>';
}

// ============================================================================
// RATING SYSTEMS  
// ============================================================================

function initializeRatingSystems() {
    // Star ratings
    document.querySelectorAll('.star-rating').forEach(rating => {
        const stars = rating.querySelectorAll('.star');
        
        stars.forEach((star, index) => {
            star.addEventListener('click', function() {
                const ratingValue = index + 1;
                
                stars.forEach((s, i) => {
                    if (i < ratingValue) {
                        s.classList.add('filled');
                        s.classList.remove('empty');
                    } else {
                        s.classList.remove('filled');
                        s.classList.add('empty');
                    }
                });
                
                showNotification(`Rated: ${ratingValue} stars`, 'success', 2000);
                trackEvent('rating_given', { value: ratingValue, type: 'star' });
            });
        });
    });
    
    // Thumbs ratings
    document.querySelectorAll('.thumbs-up, .thumbs-down').forEach(thumb => {
        thumb.addEventListener('click', function() {
            const isThumbsUp = this.classList.contains('thumbs-up');
            const countElement = this.querySelector('.thumb-count');
            const currentCount = parseInt(countElement.textContent);
            
            countElement.textContent = currentCount + 1;
            
            showNotification(
                `Thank you for your ${isThumbsUp ? 'positive' : 'negative'} feedback!`, 
                'success', 
                2000
            );
            
            trackEvent('thumbs_rating', { 
                type: isThumbsUp ? 'up' : 'down',
                newCount: currentCount + 1
            });
            
            this.style.transform = 'scale(0.9)';
            setTimeout(() => {
                this.style.transform = '';
            }, 150);
        });
    });
    
    // Animate progress bars on scroll
    const progressObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const progressBars = entry.target.querySelectorAll('.breakdown-fill');
                progressBars.forEach(bar => {
                    const width = bar.style.width;
                    bar.style.width = '0%';
                    setTimeout(() => {
                        bar.style.width = width;
                    }, 300);
                });
            }
        });
    }, { threshold: 0.5 });
    
    document.querySelectorAll('.rating-display').forEach(display => {
        progressObserver.observe(display);
    });
}

// ============================================================================
// SIDEBAR NAVIGATION
// ============================================================================

function initializeSidebarNavigation() {
    const sidebarToggle = document.getElementById('sidebarDemoToggle');
    const sidebarOverlay = document.getElementById('demoSidebarOverlay');
    const sidebar = document.getElementById('demoSidebar');
    const sidebarClose = document.getElementById('demoSidebarClose');
    
    if (sidebarToggle && sidebarOverlay && sidebar) {
        sidebarToggle.addEventListener('click', function() {
            sidebarOverlay.style.display = 'block';
            setTimeout(() => {
                sidebar.classList.add('open');
            }, 10);
            
            trackEvent('sidebar_opened');
        });
        
        const closeSidebar = () => {
            sidebar.classList.remove('open');
            setTimeout(() => {
                sidebarOverlay.style.display = 'none';
            }, 300);
            
            trackEvent('sidebar_closed');
        };
        
        if (sidebarClose) {
            sidebarClose.addEventListener('click', closeSidebar);
        }
        
        sidebarOverlay.addEventListener('click', function(e) {
            if (e.target === sidebarOverlay) {
                closeSidebar();
            }
        });
        
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape' && sidebar.classList.contains('open')) {
                closeSidebar();
            }
        });
    }
    
    // Demo navigation items
    document.querySelectorAll('.demo-nav-link').forEach(link => {
        link.addEventListener('click', function(e) {
            e.preventDefault();
            
            document.querySelectorAll('.demo-nav-item').forEach(item => {
                item.classList.remove('active');
            });
            
            this.closest('.demo-nav-item').classList.add('active');
            
            const text = this.querySelector('.demo-nav-text').textContent;
            showNotification(`Navigated to: ${text}`, 'info', 2000);
            
            trackEvent('sidebar_navigation', { page: text });
        });
    });
    
    // Preview sidebar items
    document.querySelectorAll('.sidebar-preview-item').forEach(item => {
        item.addEventListener('click', function() {
            document.querySelectorAll('.sidebar-preview-item').forEach(i => {
                i.classList.remove('active');
            });
            
            this.classList.add('active');
            
            const label = this.querySelector('.sidebar-preview-label').textContent;
            showNotification(`Preview: ${label}`, 'info', 1500);
        });
    });
}

// ============================================================================
// BREADCRUMB NAVIGATION
// ============================================================================

function initializeBreadcrumbs() {
    document.querySelectorAll('.breadcrumb-item').forEach(item => {
        if (!item.classList.contains('current') && !item.classList.contains('collapsed')) {
            item.addEventListener('click', function(e) {
                e.preventDefault();
                
                const text = this.textContent.trim();
                showNotification(`Navigated to: ${text}`, 'info', 2000);
                
                trackEvent('breadcrumb_clicked', { 
                    page: text,
                    level: Array.from(this.parentNode.children).indexOf(this)
                });
            });
        }
    });
    
    // Expandable breadcrumbs
    document.querySelectorAll('.breadcrumb-item.collapsed').forEach(item => {
        item.addEventListener('click', function() {
            showNotification('Showing hidden path levels...', 'info', 2000);
            
            this.textContent = 'Research → Analysis';
            this.classList.remove('collapsed');
            
            trackEvent('breadcrumb_expanded');
        });
    });
}

// ============================================================================
// FLOATING ACTION BUTTONS
// ============================================================================

function initializeFloatingActionButtons() {
    // Single FABs
    document.querySelectorAll('.fab').forEach(fab => {
        if (!fab.classList.contains('fab-trigger') && !fab.classList.contains('fab-speed-dial-trigger')) {
            fab.addEventListener('click', function() {
                const tooltip = this.getAttribute('data-tooltip') || 'Action';
                showNotification(`${tooltip} clicked!`, 'success', 2000);
                
                trackEvent('fab_clicked', { action: tooltip });
                
                this.style.transform = 'scale(0.9)';
                setTimeout(() => {
                    this.style.transform = '';
                }, 150);
            });
        }
    });
    
    // FAB Menu
    const fabMenu = document.getElementById('fabMenu');
    if (fabMenu) {
        const trigger = fabMenu.querySelector('.fab-trigger');
        
        trigger.addEventListener('click', function() {
            fabMenu.classList.toggle('open');
            
            const isOpen = fabMenu.classList.contains('open');
            showNotification(`FAB menu ${isOpen ? 'opened' : 'closed'}`, 'info', 1500);
            
            trackEvent('fab_menu_toggled', { open: isOpen });
        });
    }
    
    // Speed Dial
    const fabSpeedDial = document.getElementById('fabSpeedDial');
    if (fabSpeedDial) {
        const trigger = fabSpeedDial.querySelector('.fab-speed-dial-trigger');

        if (trigger) {
            trigger.addEventListener('click', function(e) {
                e.stopPropagation();
                fabSpeedDial.classList.toggle('open');
                
                const isOpen = fabSpeedDial.classList.contains('open');
                showNotification(`Speed dial ${isOpen ? 'opened' : 'closed'}`, 'info', 1500);
                
                trackEvent('speed_dial_toggled', { open: isOpen });
            });
        }
        
        // Handle clicks on speed dial items
        const speedDialItems = fabSpeedDial.querySelectorAll('.fab-speed-dial-items .fab');
        speedDialItems.forEach(item => {
            item.addEventListener('click', function(e) {
                e.stopPropagation();
                const tooltip = this.getAttribute('data-tooltip');
                showNotification(`${tooltip} clicked!`, 'success', 2000);
                // Close the speed dial menu after clicking an item
                fabSpeedDial.classList.remove('open');
                
                trackEvent('speed_dial_item_clicked', { action: tooltip });
            });
        });
    }
    
    // Close FABs when clicking outside
    document.addEventListener('click', function(e) {
        if (!e.target.closest('.fab-menu') && !e.target.closest('.fab-speed-dial')) {
            const fabMenu = document.getElementById('fabMenu');
            const fabSpeedDial = document.getElementById('fabSpeedDial');
            
            if (fabMenu) fabMenu.classList.remove('open');
            if (fabSpeedDial) fabSpeedDial.classList.remove('open');
        }
    });
    
    // Pulse animation for primary FABs
    setInterval(() => {
        document.querySelectorAll('.fab-primary').forEach(fab => {
            if (!fab.closest('.fab-menu.open') && !fab.closest('.fab-speed-dial.open')) {
                fab.style.animation = 'pulse 2s infinite';
                setTimeout(() => {
                    fab.style.animation = '';
                }, 2000);
            }
        });
    }, 10000);
}

// ============================================================================
// PAGE-SPECIFIC FUNCTIONALITY
// ============================================================================

function initializePageSpecific() {
    const page = document.body.getAttribute('data-page');
    
    if (page === 'historical-tests') {
        initializeHistoricalTests();
    } else if (page === 'assessment') {
        initializeAssessment();
    } else if (page === 'guessing-game') {
        initializeGuessingGame();
    }
}

function initializeHistoricalTests() {
    const searchInput = document.getElementById('groupSearch');
    const counterEl = document.getElementById('resultsCounter');
    const items = Array.from(document.querySelectorAll('.list-item'));
    const total = items.length;
    const assessHeader = document.querySelector('.assessment-header');
    const mainContent = document.getElementById('main-content');

    // Helper: normalize text for matching
    const norm = (s) => (s || '').toString().toLowerCase().replace(/\s+/g, ' ').trim();

    // Filter logic
    const applyFilter = () => {
        const q = norm(searchInput?.value || '');
        let visible = 0;
        items.forEach(el => {
            const name = norm(el.querySelector('.list-item-title')?.textContent);
            const desc = norm(el.querySelector('.list-item-description')?.textContent);
            const meta = norm(el.querySelector('.list-item-meta')?.textContent);
            const slug = norm(el.getAttribute('data-group'));
            const match = !q || name.includes(q) || desc.includes(q) || meta.includes(q) || slug.includes(q);
            el.style.display = match ? '' : 'none';
            if (match) visible++;
        });
        if (counterEl) counterEl.textContent = `Showing ${visible} of ${total} analyzed groups`;
        trackEvent('group_filter_applied', { query: q, visible });
    };

    // Click/select logic
    const selectGroup = (slugOrEl) => {
        const el = typeof slugOrEl === 'string'
            ? items.find(i => norm(i.getAttribute('data-group')) === norm(slugOrEl))
            : slugOrEl;
        if (!el) return;

        items.forEach(i => i.classList.remove('selected'));
        el.classList.add('selected');

        const title = el.querySelector('.list-item-title')?.textContent?.trim() || 'Selected Group';
        if (assessHeader) assessHeader.textContent = `🏛️ Analyzing: ${title}`;

        const slug = el.getAttribute('data-group') || '';
        if (slug) history.replaceState(null, '', `#${slug}`);

        if (mainContent) mainContent.scrollIntoView({ behavior: 'smooth', block: 'start' });
        showNotification(`Loaded: ${title}`, 'success', 1500);
        trackEvent('group_selected', { slug, title });
    };

    // Wire up search box
    if (searchInput) {
        searchInput.addEventListener('input', applyFilter);
        applyFilter();
    } else if (counterEl) {
        counterEl.textContent = `Showing ${total} of ${total} analyzed groups`;
    }

    // Wire up item clicks
    items.forEach(el => {
        el.style.cursor = 'pointer';
        el.addEventListener('click', () => selectGroup(el));
        el.addEventListener('keypress', (e) => { if (e.key === 'Enter') selectGroup(el); });
        el.setAttribute('tabindex', '0');
        el.setAttribute('role', 'button');
        el.setAttribute('aria-label', `View ${el.querySelector('.list-item-title')?.textContent?.trim() || 'group'}`);
    });

    // Deep link: auto-select from hash on load
    if (location.hash) {
        const slug = location.hash.slice(1);
        if (slug) selectGroup(slug);
    }
}

function initializeAssessment() {
    console.log('Assessment page initialized');
    // Add assessment-specific functionality here
}

function initializeGuessingGame() {
    console.log('Guessing game initialized');
    // Add guessing game functionality here
}