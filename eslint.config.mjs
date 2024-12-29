import eslintPluginPrettierRecommended from "eslint-plugin-prettier/recommended"
import tseslint from "typescript-eslint"

export default tseslint.config(
	tseslint.configs.base,
	eslintPluginPrettierRecommended,
	{
		files: ["**/*.{ts,tsx}"],
		ignores: ["src/server/**"],
		plugins: {
			reactHooks: {
				rules: {
					"react-hooks/rules-of-hooks": "error",
					"react-hooks/exhaustive-deps": "warn",
				},
			},
		},
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			"@typescript-eslint/no-floating-promises": "error",
			"@typescript-eslint/no-unused-vars": [
				"warn",
				{
					args: "all",
					argsIgnorePattern: "^_",
					caughtErrors: "all",
					caughtErrorsIgnorePattern: "^_",
					destructuredArrayIgnorePattern: "^_",
					varsIgnorePattern: "^_",
					ignoreRestSiblings: true,
				},
			],
			"@typescript-eslint/ban-types": "off",
			"@typescript-eslint/no-redeclare": "off",
			"require-await": "warn",
			"prettier/prettier": 0,
			"import/order": "off",
			"no-undef": "off",
		},
	},
)
