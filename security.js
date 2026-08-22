/* =========================================================
   LOCDAILYMAR
   CENTRAL SESSION SECURITY
   FASE 1D-B
   ========================================================= */


const SECURITY_CONFIG = {

    LOGIN_PAGE:
        "index.html",

    DASHBOARD_PAGE:
        "dashboard.html",

    /*
     * Maksimal umur session.
     * 30 menit.
     */
    SESSION_TIMEOUT:
        30 * 60 * 1000,

    /*
     * Jika tidak ada aktivitas selama
     * 15 menit, session dianggap idle.
     */
    IDLE_TIMEOUT:
        15 * 60 * 1000,

    /*
     * Refresh timestamp maksimal
     * setiap 60 detik.
     */
    ACTIVITY_REFRESH_INTERVAL:
        60 * 1000

};


/* =========================================================
   AMBIL SESSION
   ========================================================= */

function getSecuritySession() {

    const rawSession =
        localStorage.getItem(
            "loginSession"
        );


    /*
     * Session baru
     */

    if (rawSession) {

        try {

            const session =
                JSON.parse(
                    rawSession
                );


            if (
                !session ||
                !session.token ||
                !session.username ||
                !session.role ||
                !session.createdAt ||
                !session.lastActivity
            ) {

                clearSecuritySession();

                return null;

            }


            const now =
                Date.now();


            /*
             * Session maksimum
             */

            if (
                now -
                Number(session.createdAt)
                >
                SECURITY_CONFIG.SESSION_TIMEOUT
            ) {

                clearSecuritySession();

                return null;

            }


            /*
             * Idle timeout
             */

            if (
                now -
                Number(session.lastActivity)
                >
                SECURITY_CONFIG.IDLE_TIMEOUT
            ) {

                clearSecuritySession();

                return null;

            }


            return {

                token:
                    session.token,

                username:
                    session.username
                        .toString()
                        .trim(),

                role:
                    session.role
                        .toString()
                        .trim()
                        .toLowerCase(),

                createdAt:
                    Number(session.createdAt),

                lastActivity:
                    Number(session.lastActivity)

            };

        } catch (error) {

            console.error(
                "Session rusak:",
                error
            );

            clearSecuritySession();

            return null;

        }

    }


    /*
     * -----------------------------------------------------
     * FALLBACK SESSION LAMA
     * -----------------------------------------------------
     *
     * Ini sementara agar halaman lama tidak langsung
     * rusak ketika security.js pertama kali dipasang.
     */

    const isLoggedIn =
        localStorage.getItem(
            "isLoggedIn"
        );


    const username =
        localStorage.getItem(
            "username"
        );


    const role =
        localStorage.getItem(
            "userRole"
        );


    const loginTimestamp =
        parseInt(
            localStorage.getItem(
                "loginTimestamp"
            ) || "0",
            10
        );


    if (
        isLoggedIn !== "true" ||
        !username ||
        !role ||
        !loginTimestamp
    ) {

        return null;

    }


    const now =
        Date.now();


    if (
        now -
        loginTimestamp
        >
        SECURITY_CONFIG.SESSION_TIMEOUT
    ) {

        clearSecuritySession();

        return null;

    }


    /*
     * Session lama masih valid.
     *
     * Kita konversi ke session baru.
     */

    const newSession = {

        token:
            generateSecurityToken(),

        username:
            username
                .toString()
                .trim(),

        role:
            role
                .toString()
                .trim()
                .toLowerCase(),

        createdAt:
            loginTimestamp,

        lastActivity:
            now

    };


    localStorage.setItem(
        "loginSession",
        JSON.stringify(
            newSession
        )
    );


    return newSession;

}


/* =========================================================
   TOKEN SESSION
   ========================================================= */

function generateSecurityToken() {

    if (
        window.crypto &&
        typeof crypto.randomUUID ===
        "function"
    ) {

        return crypto.randomUUID();

    }


    const buffer =
        new Uint8Array(32);


    crypto.getRandomValues(
        buffer
    );


    return Array
        .from(buffer)
        .map(
            byte =>
                byte
                    .toString(16)
                    .padStart(2, "0")
        )
        .join("");

}


/* =========================================================
   BUAT SESSION
   ========================================================= */

function createSecuritySession(
    account
) {

    if (
        !account ||
        !account.username ||
        !account.role
    ) {

        throw new Error(
            "Data akun tidak valid."
        );

    }


    const now =
        Date.now();


    const session = {

        token:
            generateSecurityToken(),

        username:
            account.username
                .toString()
                .trim(),

        role:
            account.role
                .toString()
                .trim()
                .toLowerCase(),

        createdAt:
            now,

        lastActivity:
            now

    };


    localStorage.setItem(
        "loginSession",
        JSON.stringify(
            session
        )
    );


    /*
     * Variabel lama dipertahankan
     * sementara untuk kompatibilitas.
     */

    localStorage.setItem(
        "isLoggedIn",
        "true"
    );


    localStorage.setItem(
        "username",
        session.username
    );


    localStorage.setItem(
        "userRole",
        session.role
    );


    localStorage.setItem(
        "loginTimestamp",
        now.toString()
    );


    return session;

}


/* =========================================================
   WAJIB LOGIN
   ========================================================= */

function requireLogin() {

    const session =
        getSecuritySession();


    if (!session) {

        clearSecuritySession();


        window.location.replace(
            SECURITY_CONFIG.LOGIN_PAGE
        );


        return null;

    }


    return session;

}


/* =========================================================
   CEK ROLE
   ========================================================= */

function requireRole(
    allowedRoles = []
) {

    const session =
        requireLogin();


    if (!session) {

        return null;

    }


    const allowed =
        allowedRoles
            .map(
                role =>
                    role
                        .toString()
                        .trim()
                        .toLowerCase()
            );


    if (
        !allowed.includes(
            session.role
        )
    ) {

        window.location.replace(
            SECURITY_CONFIG.DASHBOARD_PAGE
        );


        return null;

    }


    return session;

}


/* =========================================================
   REFRESH SESSION
   ========================================================= */

let lastActivityRefresh = 0;


function refreshSecuritySession() {

    const session =
        getSecuritySession();


    if (!session) {

        return false;

    }


    const now =
        Date.now();


    /*
     * Jangan menulis localStorage
     * setiap event mouse.
     */

    if (
        now -
        lastActivityRefresh
        <
        SECURITY_CONFIG
            .ACTIVITY_REFRESH_INTERVAL
    ) {

        return true;

    }


    lastActivityRefresh =
        now;


    session.lastActivity =
        now;


    localStorage.setItem(
        "loginSession",
        JSON.stringify(
            session
        )
    );


    /*
     * Kompatibilitas dengan sistem lama.
     */

    localStorage.setItem(
        "loginTimestamp",
        now.toString()
    );


    return true;

}


/* =========================================================
   DETEKSI AKTIVITAS USER
   ========================================================= */

function registerSecurityActivity() {

    refreshSecuritySession();

}


[
    "click",
    "keydown",
    "mousemove",
    "touchstart",
    "scroll"
].forEach(
    eventName => {

        document.addEventListener(
            eventName,
            registerSecurityActivity,
            {
                passive: true
            }
        );

    }
);


/* =========================================================
   AUTO CHECK SESSION
   ========================================================= */

setInterval(
    () => {

        const session =
            getSecuritySession();


        if (!session) {

            return;

        }

    },
    10 * 1000
);


/* =========================================================
   LOGOUT
   ========================================================= */

function clearSecuritySession() {

    localStorage.removeItem(
        "loginSession"
    );


    localStorage.removeItem(
        "isLoggedIn"
    );


    localStorage.removeItem(
        "userRole"
    );


    localStorage.removeItem(
        "username"
    );


    localStorage.removeItem(
        "activeUsername"
    );


    localStorage.removeItem(
        "loggedInUser"
    );


    localStorage.removeItem(
        "activeUserId"
    );


    localStorage.removeItem(
        "loginTimestamp"
    );


    /*
     * Beri tahu tab lain bahwa session
     * sudah dihentikan.
     */

    localStorage.setItem(
        "securityLogoutEvent",
        Date.now().toString()
    );

}


/* =========================================================
   LOGOUT AMAN
   ========================================================= */

function secureLogout() {

    clearSecuritySession();


    window.location.replace(
        SECURITY_CONFIG.LOGIN_PAGE
    );

}


/* =========================================================
   LOGOUT / SESSION SYNC ANTAR TAB
   ========================================================= */

window.addEventListener(
    "storage",
    function(event) {

        if (
            event.key ===
            "securityLogoutEvent"
        ) {

            clearSecuritySession();


            if (
                !window.location.pathname
                    .toLowerCase()
                    .endsWith(
                        "index.html"
                    )
            ) {

                window.location.replace(
                    SECURITY_CONFIG.LOGIN_PAGE
                );

            }

        }


        /*
         * Jika loginSession dihapus dari tab lain,
         * halaman ini juga harus keluar.
         */

        if (
            event.key ===
            "loginSession"
        ) {

            if (
                !event.newValue
            ) {

                clearSecuritySession();


                if (
                    !window.location.pathname
                        .toLowerCase()
                        .endsWith(
                            "index.html"
                        )
                ) {

                    window.location.replace(
                        SECURITY_CONFIG.LOGIN_PAGE
                    );

                }

            }

        }

    }
);