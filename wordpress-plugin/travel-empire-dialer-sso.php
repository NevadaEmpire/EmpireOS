<?php
/**
 * Plugin Name: Travel Empire Dialer SSO
 * Description: Opens the Travel Empire Dialer using the advisor's existing CRM session.
 * Version: 1.2.1
 */

if (!defined('ABSPATH')) exit;

function te_dialer_sso_url() {
    if (!is_user_logged_in()) return wp_login_url(admin_url('admin.php?page=te-dialer'));
    if (!defined('TE_DIALER_SSO_SECRET') || strlen(TE_DIALER_SSO_SECRET) < 32) return '';
    $user = wp_get_current_user();
    $payload = [
        'username' => sanitize_user($user->user_login),
        'email' => sanitize_email($user->user_email),
        'displayName' => sanitize_text_field($user->display_name),
        'isAdmin' => user_can($user, 'manage_options'),
        'exp' => time() + 60,
    ];
    $token = rtrim(strtr(base64_encode(wp_json_encode($payload)), '+/', '-_'), '=');
    $sig = hash_hmac('sha256', $token, TE_DIALER_SSO_SECRET);
    return 'https://dialer.travelempire.org/auth/sso?token=' . rawurlencode($token) . '&sig=' . $sig;
}

function te_dialer_register_menu() {
    add_menu_page('Travel Empire Dialer', 'Dialer', 'read', 'te-dialer', 'te_dialer_fallback_page', 'dashicons-phone', 3);
}
add_action('admin_menu', 'te_dialer_register_menu');

/** Redirect before WordPress outputs the admin header or CRM navigation. */
function te_dialer_early_redirect() {
    if (!is_admin() || !is_user_logged_in()) return;
    if (!isset($_GET['page']) || sanitize_key(wp_unslash($_GET['page'])) !== 'te-dialer') return;

    $url = te_dialer_sso_url();
    if (!$url) wp_die('Dialer SSO is not configured. Add TE_DIALER_SSO_SECRET to wp-config.php.');
    wp_redirect($url);
    exit;
}
add_action('admin_init', 'te_dialer_early_redirect', 1);

function te_dialer_fallback_page() {
    echo '<div class="wrap"><h1>Travel Empire Dialer</h1><p>Opening the dialer…</p></div>';
}

function te_dialer_admin_bar($bar) {
    if (!is_user_logged_in()) return;
    if (defined('TE_DIALER_SSO_SECRET') && strlen(TE_DIALER_SSO_SECRET) >= 32) {
        $bar->add_node([
            'id' => 'te-dialer',
            'title' => 'Open Dialer',
            'href' => admin_url('admin.php?page=te-dialer'),
        ]);
    }
}
add_action('admin_bar_menu', 'te_dialer_admin_bar', 90);

/**
 * Update the CRM's legacy dialer shortcuts without modifying the CRM theme.
 * The stable WordPress route creates a fresh, short-lived SSO token when clicked.
 */
function te_dialer_update_legacy_navigation() {
    if (!is_user_logged_in()) return;
    $dialer_route = admin_url('admin.php?page=te-dialer');
    ?>
    <script>
    (() => {
        const dialerRoute = <?php echo wp_json_encode($dialer_route); ?>;

        const addMenuToggle = () => {
            if (document.getElementById('te-crm-menu-toggle')) return;
            const wpMenu = document.getElementById('adminmenumain');
            if (!wpMenu) return;

            const toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.id = 'te-crm-menu-toggle';
            toggle.setAttribute('aria-label', 'Collapse CRM menu');
            toggle.setAttribute('aria-expanded', 'true');
            toggle.innerHTML = '<span aria-hidden="true">‹</span>';
            const positionToggle = () => {
                const menu = document.getElementById('adminmenumain');
                if (menu) toggle.style.left = Math.max(0, Math.round(menu.getBoundingClientRect().right)) + 'px';
            };
            toggle.addEventListener('click', () => {
                const nativeToggle = document.getElementById('collapse-menu');
                if (nativeToggle) {
                    nativeToggle.click();
                } else {
                    document.body.classList.toggle('folded');
                }
                window.setTimeout(() => {
                    const collapsed = document.body.classList.contains('folded');
                    toggle.innerHTML = '<span aria-hidden="true">' + (collapsed ? '›' : '‹') + '</span>';
                    toggle.setAttribute('aria-label', collapsed ? 'Expand CRM menu' : 'Collapse CRM menu');
                    toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
                    positionToggle();
                }, 50);
            });
            document.body.appendChild(toggle);
            positionToggle();
            window.addEventListener('resize', positionToggle);
        };

        const updateLinks = () => {
            addMenuToggle();
            document.querySelectorAll('a, button').forEach((element) => {
                const label = (element.textContent || '').trim().replace(/\s+/g, ' ').toLowerCase();

                if (label === 'rapid dial' || label === 'start rapid dial') {
                    element.textContent = 'Open Dialer';
                    if (element.tagName === 'A') {
                        element.href = dialerRoute;
                        element.removeAttribute('target');
                    } else if (!element.dataset.teDialerBound) {
                        element.dataset.teDialerBound = 'true';
                        element.addEventListener('click', (event) => {
                            event.preventDefault();
                            window.location.assign(dialerRoute);
                        }, true);
                    }
                }

                if (label === 'justcall' || label === 'open justcall') {
                    element.hidden = true;
                    element.setAttribute('aria-hidden', 'true');
                }
            });
        };

        updateLinks();
        new MutationObserver(updateLinks).observe(document.body, { childList: true, subtree: true });
    })();
    </script>
    <style>
        #te-crm-menu-toggle {
            position: fixed;
            z-index: 100001;
            top: 50%;
            left: 160px;
            width: 30px;
            height: 54px;
            margin: -27px 0 0;
            padding: 0;
            border: 1px solid #4d456f;
            border-left: 0;
            border-radius: 0 12px 12px 0;
            background: linear-gradient(180deg, #675da0, #403867);
            color: #fff;
            box-shadow: 0 8px 24px rgba(0, 0, 0, .28);
            cursor: pointer;
            font: 700 26px/1 sans-serif;
        }
        #te-crm-menu-toggle:hover,
        #te-crm-menu-toggle:focus-visible {
            background: linear-gradient(180deg, #c9a548, #8d6818);
            outline: 2px solid rgba(212, 175, 55, .4);
            outline-offset: 2px;
        }
        @media (max-width: 782px) {
            #te-crm-menu-toggle { display: none; }
        }
    </style>
    <?php
}
add_action('admin_footer', 'te_dialer_update_legacy_navigation', 100);
