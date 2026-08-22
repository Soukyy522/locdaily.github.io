
(function () {
    "use strict";

    const ACCOUNT_KEY = "daftarAkun";
    const EMPLOYEE_KEY = "daftarKaryawan";
    const SERIAL_KEY = "employeeNikSerial";

    function parse(raw, fallback) {
        try {
            const value = JSON.parse(raw);
            return value ?? fallback;
        } catch (_) {
            return fallback;
        }
    }

    function normalizeUsername(value) {
        return String(value || "").trim().toLowerCase();
    }

    function normalizeNik(value) {
        return String(value || "").replace(/\D/g, "");
    }

    function getAccounts() {
        return parse(localStorage.getItem(ACCOUNT_KEY), []);
    }

    function saveAccounts(accounts) {
        localStorage.setItem(
            ACCOUNT_KEY,
            JSON.stringify(accounts)
        );
    }

    function getEmployees() {
        return parse(localStorage.getItem(EMPLOYEE_KEY), []);
    }

    function saveEmployees(employees) {
        localStorage.setItem(
            EMPLOYEE_KEY,
            JSON.stringify(employees)
        );
    }

    function randomEmployeeId() {
        if (
            window.crypto &&
            typeof crypto.randomUUID === "function"
        ) {
            return "emp_" + crypto.randomUUID();
        }

        return (
            "emp_" +
            Date.now().toString(36) +
            "_" +
            Math.random().toString(36).slice(2, 10)
        );
    }

    function nextNik() {
        const now = new Date();
        const yy = String(now.getFullYear()).slice(-2);
        const mm = String(now.getMonth() + 1).padStart(2, "0");

        let serial =
            Number(
                localStorage.getItem(SERIAL_KEY) || 0
            );

        serial += 1;

        localStorage.setItem(
            SERIAL_KEY,
            String(serial)
        );

        return (
            yy +
            mm +
            String(serial).padStart(3, "0")
        );
    }

    function findByUsername(username) {
        const key = normalizeUsername(username);

        return getEmployees().find(
            employee =>
                employee &&
                employee.active !== false &&
                normalizeUsername(
                    employee.username
                ) === key
        ) || null;
    }

    function findByNik(nik) {
        const key = normalizeNik(nik);

        return getEmployees().find(
            employee =>
                employee &&
                employee.active !== false &&
                normalizeNik(
                    employee.nikKaryawan
                ) === key
        ) || null;
    }

    function ensureMigration() {
        const accounts = getAccounts();
        const employees = getEmployees();

        let accountsChanged = false;
        let employeesChanged = false;

        for (const account of accounts) {
            if (!account || !account.username) {
                continue;
            }

            let employee =
                employees.find(
                    item =>
                        item &&
                        normalizeUsername(item.username) ===
                        normalizeUsername(account.username)
                );

            if (!employee) {
                employee = {
                    employeeId:
                        account.employeeId ||
                        randomEmployeeId(),

                    nikKaryawan:
                        account.nikKaryawan ||
                        nextNik(),

                    /*
                     * Nama Karyawan tidak memiliki input terpisah.
                     * Nilainya selalu mengikuti username.
                     */
                    namaKaryawan:
                        String(account.username).trim(),

                    username:
                        String(account.username).trim(),

                    role:
                        String(account.role || "kasir"),

                    active:
                        account.active !== false,

                    createdAt:
                        Date.now()
                };

                employees.push(employee);
                employeesChanged = true;
            }

            if (
                employee.username !==
                String(account.username).trim()
                ||
                employee.namaKaryawan !==
                String(account.username).trim()
            ) {
                employee.username =
                    String(account.username).trim();

                employee.namaKaryawan =
                    String(account.username).trim();

                employee.role =
                    String(
                        account.role ||
                        employee.role ||
                        "kasir"
                    );

                employeesChanged = true;
            }

            if (
                account.employeeId !==
                employee.employeeId
            ) {
                account.employeeId =
                    employee.employeeId;

                accountsChanged = true;
            }

            if (
                account.nikKaryawan !==
                employee.nikKaryawan
            ) {
                account.nikKaryawan =
                    employee.nikKaryawan;

                accountsChanged = true;
            }

            if (
                account.namaKaryawan !==
                employee.namaKaryawan
            ) {
                account.namaKaryawan =
                    employee.namaKaryawan;

                accountsChanged = true;
            }
        }

        if (accountsChanged) {
            saveAccounts(accounts);
        }

        if (employeesChanged) {
            saveEmployees(employees);
        }

        return {
            accounts: getAccounts(),
            employees: getEmployees()
        };
    }

    function createForAccount(account) {
        ensureMigration();

        const username =
            String(account?.username || "").trim();

        if (!username) {
            throw new Error("Username wajib diisi.");
        }

        const employees = getEmployees();

        const existing =
            employees.find(
                item =>
                    item &&
                    normalizeUsername(item.username) ===
                    normalizeUsername(username)
            );

        if (existing) {
            return existing;
        }

        const employee = {
            employeeId: randomEmployeeId(),
            nikKaryawan: nextNik(),
            namaKaryawan: username,
            username,
            role: String(account?.role || "kasir"),
            active: true,
            createdAt: Date.now()
        };

        employees.push(employee);
        saveEmployees(employees);

        return employee;
    }

    function updateUsername(
        oldUsername,
        newUsername,
        role
    ) {
        ensureMigration();

        const employees = getEmployees();

        const employee =
            employees.find(
                item =>
                    item &&
                    normalizeUsername(item.username) ===
                    normalizeUsername(oldUsername)
            );

        if (!employee) {
            return null;
        }

        /*
         * NIK dan employeeId TIDAK berubah.
         * Nama Karyawan otomatis mengikuti username baru.
         */
        employee.username =
            String(newUsername).trim();

        employee.namaKaryawan =
            String(newUsername).trim();

        employee.role =
            String(role || employee.role || "kasir");

        saveEmployees(employees);

        return employee;
    }

    function deactivateByUsername(username) {
        ensureMigration();

        const employees = getEmployees();

        const employee =
            employees.find(
                item =>
                    item &&
                    normalizeUsername(item.username) ===
                    normalizeUsername(username)
            );

        if (employee) {
            employee.active = false;
            employee.deactivatedAt = Date.now();
            saveEmployees(employees);
        }

        return employee || null;
    }

    function resolveLogin(identifier) {
        ensureMigration();

        const raw =
            String(identifier || "").trim();

        const byNik =
            findByNik(raw);

        if (byNik) {
            return {
                username: byNik.username,
                employee: byNik,
                via: "nik"
            };
        }

        const byUsername =
            findByUsername(raw);

        return {
            username:
                byUsername
                    ? byUsername.username
                    : raw,
            employee: byUsername,
            via: "username"
        };
    }

    window.LDMEmployee = {
        ensureMigration,
        getEmployees,
        findByUsername,
        findByNik,
        createForAccount,
        updateUsername,
        deactivateByUsername,
        resolveLogin,
        nextNik
    };

    ensureMigration();
})();
