const security = require("eslint-plugin-security");

module.exports = [
  {
    files: ["**/*.js"],
    ignores: ["node_modules/**", "testssl.sh/**"],
    plugins: {
      security,
    },
    rules: {
      ...security.configs.recommended.rules,
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
    },
  },
];
