import { hc } from 'hono/client';
import type { AppType } from './types';
import { dev } from '$app/environment';
import { PUBLIC_DEV_BACKEND_URL } from '$env/static/public';

export const hClient = hc<AppType>(dev ? PUBLIC_DEV_BACKEND_URL : '/', {
	fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
		try {
			const response = await fetch(input, init);

			if (!response.ok) {
				const errorText = await response.text();
				const errorMessage = `Fetch error: ${response.status} ${response.statusText} - ${errorText}`;
				console.error(errorMessage);
				throw new Error(errorMessage);
			}

			return response;
		} catch (error) {
			console.error('Fetch failed:', error);
			throw error;
		}
	}
}).api;
