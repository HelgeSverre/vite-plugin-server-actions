const noop = () => {};

/**
 * Create the plugin's internal logger. When `silent` is true, informational
 * output (log/info) and advisory warnings are suppressed; errors always print.
 * @param {boolean} [silent=false] - Suppress log/info/warn output
 * @returns {{ log: Function, info: Function, warn: Function, error: Function }}
 */
export function createLogger(silent = false) {
	return {
		log: silent ? noop : (...args) => console.log(...args),
		info: silent ? noop : (...args) => console.info(...args),
		warn: silent ? noop : (...args) => console.warn(...args),
		error: (...args) => console.error(...args),
	};
}
