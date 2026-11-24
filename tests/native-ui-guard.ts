import ts from 'typescript';

// Universal Expo UI types accept RN percentages, but Compose dimensions do not.
// Keep this scoped to native sizing: normal React Native percentage styles are valid.
export function nativePercentageErrors(source: ts.SourceFile): string[] {
  const dimensions = new Set<string>(), buttons = new Set<string>(), errors: string[] = [];
  for (const statement of source.statements) if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text.startsWith('@expo/ui')) {
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) for (const binding of bindings.elements) {
      const original = binding.propertyName?.text ?? binding.name.text;
      if (statement.moduleSpecifier.text.includes('modifiers') && ['width', 'height', 'size', 'requiredWidth', 'requiredHeight', 'requiredSize'].includes(original)) dimensions.add(binding.name.text);
      if (['Button', 'OutlinedButton'].includes(original)) buttons.add(binding.name.text);
    }
  }
  const percentage = (node: ts.Node) => ts.isStringLiteralLike(node) && node.text.includes('%');
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && dimensions.has(node.expression.getText(source)) && node.arguments.some(percentage)) errors.push('Native sizing modifier contains a percentage');
    if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && buttons.has(node.tagName.getText(source))) {
      const style = node.attributes.properties.filter(ts.isJsxAttribute).find(attribute => attribute.name.getText(source) === 'style')?.initializer;
      if (style && ts.isJsxExpression(style) && style.expression && ts.isObjectLiteralExpression(style.expression)) for (const property of style.expression.properties) {
        if (ts.isPropertyAssignment(property) && ['width', 'height'].includes(property.name.getText(source)) && percentage(property.initializer)) errors.push('Native button style contains a percentage');
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source); return errors;
}
