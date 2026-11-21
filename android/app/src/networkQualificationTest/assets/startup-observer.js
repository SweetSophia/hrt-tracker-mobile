// Instrumentation asset only. It observes; it never seeds settings or disables networking.
/* global window, document, location, XMLHttpRequest */
(() => {
    if (window !== window.top) return;
    const keys = [
        'auth_token',
        'auth_user',
        'enc_key',
        'hrt-usynthetic-events',
        'hrt-usynthetic-masc-events',
        'app-auto-backup',
    ];
    const storage = () => Object.fromEntries(keys.map(key => [key, localStorage.getItem(key)]));
    const state = {
        early: { readyState: document.readyState, bodyPresent: document.body !== null, origin: location.origin },
        initialStorage: storage(),
        attempts: [],
        resources: [],
        overflow: false,
    };
    const append = (list, value) => {
        if (list.length >= 1000) state.overflow = true;
        else list.push(value);
    };
    const record = (channel, value) =>
        append(state.attempts, { channel, url: value instanceof Request ? value.url : String(value) });
    const originalFetch = window.fetch;
    window.fetch = function (input, init) {
        record('fetch', input);
        return originalFetch.call(this, input, init);
    };
    XMLHttpRequest.prototype.open = new Proxy(XMLHttpRequest.prototype.open, {
        apply(target, receiver, args) {
            record('xhr', args[1]);
            return Reflect.apply(target, receiver, args);
        },
    });
    navigator.sendBeacon = new Proxy(navigator.sendBeacon, {
        apply(target, receiver, args) {
            record('beacon', args[0]);
            return Reflect.apply(target, receiver, args);
        },
    });
    window.WebSocket = new Proxy(window.WebSocket, {
        construct(target, args) {
            record('websocket', args[0]);
            return Reflect.construct(target, args);
        },
    });
    document.addEventListener('securitypolicyviolation', event => record('csp', event.blockedURI));
    const resources = entries => {
        for (const entry of entries) append(state.resources, { url: entry.name, initiator: entry.initiatorType });
    };
    const observer = new PerformanceObserver(list => resources(list.getEntries()));
    observer.observe({ type: 'resource', buffered: true });
    Object.defineProperty(window, '__hrtStartupNetwork', {
        value: {
            read() {
                resources(observer.takeRecords());
                return { ...state, currentStorage: storage(), online: navigator.onLine, origin: location.origin };
            },
        },
    });
})();
