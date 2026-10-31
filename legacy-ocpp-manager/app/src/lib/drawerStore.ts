import type { HTMLButtonAttributes } from 'svelte/elements';
import { writable } from 'svelte/store';
import { z } from 'zod';

export type NumberField = {
	type: 'number';
	defaultValue?: number;
	onChange?: (value: null | number) => void;
};

export type TextField = {
	type: 'text';
	defaultValue?: string;
	onChange?: (value: null | string) => void;
};

export type CheckboxField = {
	type: 'checkbox';
	defaultValue?: boolean;
	onChange?: (value: null | boolean) => void;
};

export type DropdownField<T extends readonly { label: string; value: string }[]> = {
	type: 'dropdown';
	options: T;
	defaultValue?: T[number]['value'];
	onChange?: (value: null | string) => void;
};

export type DateField = {
	type: 'date';
	defaultValue?: string;
	onChange?: (value: null | string) => void;
};

export type Field = {
	name: string;
	label: string;
	placeholder?: string;
	validation?: z.ZodType<any, any, any>;
	class?: string;
} & (
	| TextField
	| NumberField
	| CheckboxField
	| DropdownField<readonly { label: string; value: string }[]>
	| DateField
);

export type FieldValueMap = {
	text: string;
	number: number;
	checkbox: boolean;
	dropdown: string;
	date: string; // Date is represented as string ('YYYY-MM-DD')
};

type ExtractFieldValue<F extends readonly Field[], Name extends F[number]['name']> =
	Extract<F[number], { name: Name }> extends { type: keyof FieldValueMap }
		? FieldValueMap[Extract<F[number], { name: Name }>['type']]
		: never;

export type FieldValues<F extends readonly Field[]> = {
	[K in F[number]['name']]: ExtractFieldValue<F, K>;
};

export type Action<TFieldValues> = {
	key: string;
	label: string;
	class?: string;
	buttonType?: HTMLButtonAttributes['type'];
	callback: (data: { fieldValues: TFieldValues; closeDrawer: () => void }) => void;
};

export type DrawerState<F extends readonly Field[]> = {
	header: string;
	fields: F;
	actions: Action<FieldValues<F>>[];
};

// Helper type to extract default values from fields
type DefaultValues<F extends readonly Field[]> = Partial<{
	[K in F[number]['name']]: Extract<F[number], { name: K }>['defaultValue'];
}>;

// Helper to create a Zod schema from fields
type FieldSchema<F extends Field> = F extends { validation: infer V } ? V : never;

type DrawerSchema<F extends readonly Field[]> = {
	[K in F[number]['name']]: FieldSchema<Extract<F[number], { name: K }>>;
};

export const drawerStore = createDrawerStore();

function createDrawerStore() {
	const { subscribe, set, update } = writable<DrawerState<readonly Field[]> | null>(null);

	return {
		subscribe,
		open: <F extends readonly Field[]>(
			state: DrawerState<F> & {
				defaultValues?: DefaultValues<F>;
				schema?: Partial<DrawerSchema<F>>;
			}
		) => set(state as unknown as DrawerState<readonly Field[]>),
		close: () => set(null),

		overwriteDeep: <F extends readonly Field[]>(
			overwriteFn: (state: DrawerState<F>) => Partial<DrawerState<F>> | undefined
		) => {
			update((state) => {
				if (state) {
					const newState = overwriteFn(state as any) as unknown as typeof state;

					if (!newState) return state;

					const mergedState = {
						...state,
						...newState
					};
					return mergedState;
				}
				return state;
			});
		}
	};
}
