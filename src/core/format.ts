/** "just now", "25 min ago", "2 h ago", "3 d ago". */
export function timeAgo(iso: string, now = Date.now()) {
	const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
	if (seconds < 60) return 'just now';
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} h ago`;
	return `${Math.floor(hours / 24)} d ago`;
}

export function pad2(n: number) {
	return String(n).padStart(2, '0');
}

export function pad3(n: number) {
	return String(n).padStart(3, '0');
}

/** 24-hour "14:05:09" in the server's time zone. */
export function clock(iso: string) {
	return new Date(iso).toLocaleTimeString('en-GB', { hour12: false });
}

/** 24-hour "14:05". */
export function hourMinute(iso: string) {
	return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** "8 Oct, 14:05". */
export function shortDate(iso: string) {
	const date = new Date(iso);
	return `${date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}, ${hourMinute(iso)}`;
}

/** "5m 47s", or "25h 10m" past an hour. */
export function duration(ms: number) {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h ${pad2(Math.floor((seconds % 3600) / 60))}m`;
	return `${Math.floor(seconds / 60)}m ${pad2(seconds % 60)}s`;
}
