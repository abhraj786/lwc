/* eslint-env node */
import * as CONST from './constants';
import CustomScope from './custom-scope';
import { isTopLevelProp, parseStyles, toCamelCase, cleanJSXElement, isSvgNsAttribute, isSVG } from './utils';
import metadata from './metadata';
import { moduleExports, memoizeFunction, memoizeLookup} from './templates';

const DIRECTIVES = CONST.DIRECTIVES;
const CMP_INSTANCE = CONST.CMP_INSTANCE;
const SLOT_SET = CONST.SLOT_SET;
const API_PARAM = CONST.API_PARAM;
const MODIFIERS = CONST.MODIFIERS;
const { ITERATOR, EMPTY, VIRTUAL_ELEMENT, CREATE_ELEMENT, CUSTOM_ELEMENT, FLATTENING, TEXT } = CONST.RENDER_PRIMITIVES;

export default function({ types: t }: BabelTypes): any {
    // -- Helpers ------------------------------------------------------
    const applyPrimitive = (primitive: string) => t.identifier(`${API_PARAM}.${primitive}`);
    const applyThisToIdentifier = (path: any): any => path.replaceWith(t.memberExpression(t.identifier(CMP_INSTANCE), path.node));
    const isWithinJSXExpression = (path: any) => path.find((p: any): boolean => p.isJSXExpressionContainer());
    const getMemberFromNodeStringLiteral = (node: BabelNodeStringLiteral, i: number = 0): string => node.value.split('.')[i];

    const BoundThisVisitor = {
        ThisExpression(path) {
            throw path.buildCodeFrameError('You can\'t use `this` within a template');
        },
        Identifier: {
            exit(path, state) {
                if (!path.node._ignore) {
                    path.stop();
                    if (state.customScope.hasBinding(path.node.name)) {
                        state.isThisApplied = true;
                        return;
                    }

                    if (path.parentPath.node.computed || !state.isThisApplied) {
                        state.isThisApplied = true;
                        metadata.addUsedId(path.node, state, t);
                        applyThisToIdentifier(path);
                    }
                }
            }
        }
    };

    const NormalizeAttributeVisitor = {
        JSXAttribute(path) {
            validatePrimitiveValues(path);
            const { node, meta } = normalizeAttributeName(path.node.name, path.get('name'));
            const value = normalizeAttributeValue(path.node.value, meta, path.get('value'));
            const nodeProperty = t.objectProperty(node, value);
            nodeProperty._meta = meta; // Attach metadata for further inspection
            path.replaceWith(nodeProperty);
        }
    };

    function validateElementMetadata(meta, path) {
        if (meta.isSlotTag && Object.keys(meta.directives).length) {
            const usedDirectives = Object.keys(meta.directives).join(',');
            throw path.buildCodeFrameError(`You can\'t use directive "${usedDirectives}" in a slot tag`);
        }
    }

    function validatePrimitiveValues(path) {
        path.traverse({ enter(path) {
            if (!path.isJSX() && !path.isIdentifier() && !path.isMemberExpression() && !path.isLiteral()) {
                throw path.buildCodeFrameError(`Node type ${path.node.type} is not allowed inside an attribute value`);
            }
        }});
    }

    function validateTemplateRootFormat(path) {
        const rootChildrens = path.get('body');

        if (!rootChildrens.length) {
            throw path.buildCodeFrameError('Missing root template tag');
        } else if (rootChildrens.length > 1) {
            throw rootChildrens.pop().buildCodeFrameError('Unexpected token');
        }

        const templateTagName = path.get('body.0.expression.openingElement.name');
        if (templateTagName.node.name !== CONST.TEMPLATE_TAG) {
            throw path.buildCodeFrameError('Root tag should be a template');
        }
    }

   // -- Plugin Visitor ------------------------------------------
    return {
        name: 'raptor-template',
        inherits: require('babel-plugin-syntax-jsx'), // Enables JSX grammar
        pre(file) {
            this.customScope = new CustomScope();
            metadata.initialize(file.metadata);
        },
        visitor: {
            Program: {
                enter(path) {
                    validateTemplateRootFormat(path);
                    // Create an artificial scope for bindings and varDeclarations
                    this.customScope.registerScopePathBindings(path);
                },
                exit(path, state) {
                    // Collect the remaining var declarations to hoist them within the export function later
                    const vars = this.customScope.getAllVarDeclarations();
                    const varDeclarations = vars && vars.length ? createVarDeclaration(vars): null;


                    const bodyPath = path.get('body');
                    const rootElement = bodyPath.find(child => (child.isExpressionStatement() && child.node.expression._jsxElement));

                    const exportDeclaration = moduleExports({ STATEMENT: rootElement.node, HOISTED_IDS: varDeclarations });
                    rootElement.replaceWithMultiple(exportDeclaration);

                    // Generate used identifiers
                    const usedIds =  state.file.metadata.templateUsedIds;
                    path.pushContainer('body',
                        t.exportNamedDeclaration(
                            t.variableDeclaration('const', [t.variableDeclarator(t.identifier('templateUsedIds'), t.valueToNode(usedIds))]), []
                        )
                    );
                }
            },
            JSXElement: {
                exit(path, status) {
                    const callExpr = buildElementCall(path, status);
                    prettyPrintExpr(callExpr);
                    path.replaceWith(t.inherits(callExpr, path.node));
                    path.node._jsxElement = true;

                    if (path.node._meta.directives[DIRECTIVES.repeat]) {
                        path.node._meta.varDeclarations = this.customScope.getAllVarDeclarations();
                        this.customScope.removeScopePathBindings(path);
                    }
                }

            },
            JSXOpeningElement: {
                enter(path, state) {
                    const meta = { directives: {}, modifiers: {}, scoped: state.customScope.getAllBindings() };
                    path.traverse(NormalizeAttributeVisitor);
                    path.node.attributes.reduce((m, attr) => groupAttrMetadata(m, attr._meta), meta);
                    path.node.name = convertJSXIdentifier(path.node.name, meta, path, state);

                    validateElementMetadata(meta, path);

                    const createsScope = !!meta.directives[DIRECTIVES.repeat];
                    if (createsScope) {
                        this.customScope.registerScopePathBindings(path, meta.scoped);
                    }

                    path.node.attributes = transformAndGroup(path.node.attributes, meta, path.get('attributes'), state);
                    path.node._meta = meta;
                }
            },
            JSXExpressionContainer(path) {
                if (!t.isIdentifier(path.node.expression) && !t.isMemberExpression(path.node.expression)) {
                    throw path.buildCodeFrameError('Expression evaluation is not allowed');
                }
            },
            // Transform container expressions from {foo.x.y} => {this.foo.x.y}
            MemberExpression(path, state) {
                if (isWithinJSXExpression(path)) {
                    path.stop();
                    path.traverse(BoundThisVisitor, { customScope : state.customScope });
                }
            },
            // Transform container expressions from {foo} => {this.foo}
            Identifier(path, state) {
                path.stop();
                if (isWithinJSXExpression(path) && !this.customScope.hasBinding(path.node.name)) {
                    metadata.addUsedId(path.node, state, t);
                    applyThisToIdentifier(path);
                }
            },
            JSXText(path) {
                const cleanedText = cleanJSXElement(path.node);
                if (cleanedText) {
                    path.replaceWith(t.stringLiteral(cleanedText));
                } else {
                    path.remove();
                }
            }
        }
    };

    function prettyPrintExpr (callExpr) {
        if (!t.isArrayExpression(callExpr)) {
            callExpr._prettyCall = true;
        }
    }

     function needsComputedCheck(literal) {
        // TODO: Look in the spec to the valid values
        return literal.indexOf('-') !== -1;
    }

    function transformBindingLiteral(literal, inScope) {
        if (inScope) {
            return t.identifier(literal);
        }
        const computed = needsComputedCheck(literal);
        const member = computed ? t.stringLiteral(literal) : t.identifier(literal);
        return t.memberExpression(t.identifier(CMP_INSTANCE), member, computed);
    }

    function createVarDeclaration(varDeclarations) {
        return t.variableDeclaration('const', varDeclarations.map(d => t.variableDeclarator(d.id, d.init)));
    }

    function applyRepeatDirectiveToNode(directives, node) {
        const forExpr = directives[MODIFIERS.for];
        const args = directives.inForScope ? directives.inForScope.map((a) => t.identifier(a)) : [];
        const blockNodes = directives.varDeclarations.length ? [createVarDeclaration(directives.varDeclarations)] : [];
        let needsFlattening = directives.isTemplate;

        if (t.isArrayExpression(node) && node.elements.length === 1) {
            node = node.elements[0];
            needsFlattening = false;
        }

        blockNodes.push(t.returnStatement(node));

        const func = t.functionExpression(null, args, t.blockStatement(blockNodes));
        const iterator = t.callExpression(applyPrimitive(ITERATOR), [forExpr, func]);
        return needsFlattening ? applyFlatteningToNode(iterator) : iterator;
    }

    function applyIfDirectiveToNode(directives, node, nextNode) {
        const directive = directives[MODIFIERS.if];
        if (nextNode && nextNode._meta && nextNode._meta.modifiers[MODIFIERS.else]) {
            nextNode._processed = true;
        } else {
            nextNode = t.callExpression(applyPrimitive(EMPTY), []);
        }
        return t.conditionalExpression(directive, node, nextNode);
    }

    function applyFlatteningToNode(elems) {
        return t.callExpression(applyPrimitive(FLATTENING), [elems]);
    }

    // Convert JSX AST into regular javascript AST
    function buildChildren(node, path, state) {
        const children = node.children;
        let needsFlattening = false;
        let hasIteration = false;
        let elems = [];

        for (let i = 0; i < children.length; i++) {
            let child = children[i];
            let nextChild = children[i + 1]
            let directives = child._meta;

            if (t.isJSXEmptyExpression(child) || child._processed) {
                continue;
            }

            if (t.isJSXExpressionContainer(child)) {
                // remove the JSXContainer <wrapper></wrapper>
                child = t.callExpression(applyPrimitive(TEXT), [child.expression]);
            }

            if (directives && directives.isSlotTag) {
                needsFlattening = true;
            }

            if (directives && (t.isCallExpression(child) || t.isArrayExpression(child))) {
                if (directives[MODIFIERS.else]) {
                    throw path.buildCodeFrameError('Else statement found before if statement');
                }

                if (directives[MODIFIERS.for]) {
                    if (directives[MODIFIERS.if]) {
                        child = applyIfDirectiveToNode(directives, child, nextChild);
                    }

                    const forTransform = applyRepeatDirectiveToNode(directives, child, state);
                    hasIteration = true;
                    elems.push(forTransform);

                    continue;
                }

                if (directives[MODIFIERS.if]) {
                    if (directives.isTemplate) {
                        const dir = directives[MODIFIERS.if];
                        const init = t.logicalExpression('||', dir, t.identifier('undefined'));
                        const id = path.scope.generateUidIdentifier('expr');
                        state.customScope.pushVarDeclaration({ id, init, kind: 'const' });

                        if (t.isArrayExpression(child)) {
                            child.elements.forEach(c => elems.push(t.logicalExpression('&&', id, c)));
                        } else {
                            elems.push(t.logicalExpression('&&', id, child));
                        }

                    } else {
                        elems.push(applyIfDirectiveToNode(directives, child, nextChild));
                    }
                    continue;
                }
            }
            elems.push(child);
        }

        if (!needsFlattening && (elems.length === 1 && hasIteration)) {
            return elems[0];
        } else {
            const multipleChilds = elems.length > 1;
            elems = t.arrayExpression(elems);
            return needsFlattening || (hasIteration && multipleChilds) ? applyFlatteningToNode(elems): elems;
        }
    }

    function parseForStatement(attrValue) {
        const inMatch = attrValue.match(/(.*?)\s+(?:in|of)\s+(.*)/);
        if (!inMatch) {
            throw new Error('For-loop value syntax is not correct');
        }

        const forSyntax = { for: null, args: [] };
        const alias = inMatch[1].trim();
        const iteratorMatch = alias.match(/\(([^,]*),([^,]*)(?:,([^,]*))?\)/);
        forSyntax.for = inMatch[2].trim();

        if (iteratorMatch) {
            forSyntax.args.push(iteratorMatch[1].trim());
            forSyntax.args.push(iteratorMatch[2].trim());
            if (iteratorMatch[3]) {
                forSyntax.args.push(iteratorMatch[3].trim());
            }
        } else {
            forSyntax.args.push(alias);
        }

        return forSyntax;
    }


    function groupSlots(attrs, wrappedChildren) {
        let slotGroups = {};
        function addSlotElement(c) {
            const slotName = c._meta && c._meta.slot || CONST.DEFAULT_SLOT_NAME;
            if (!slotGroups[slotName]) {
                slotGroups[slotName] = [];
            }

            slotGroups[slotName].push(c);
        }

        const isCallExpression = t.isCallExpression(wrappedChildren); // For flattening `api.f([...])`

        if (isCallExpression) {
            addSlotElement(wrappedChildren, true);
        } else {
            wrappedChildren.elements.forEach(c => addSlotElement(c));
        }

        const slotGroupsList = Object.keys(slotGroups).map(groupKey => {
            return t.objectProperty(t.identifier(groupKey), t.arrayExpression(slotGroups[groupKey]));
        });

        if (slotGroupsList.length) {
            attrs.properties.push(t.objectProperty(t.identifier('slotset'), t.objectExpression(slotGroupsList)))
        }
    }

    function buildElementCall(path, state) {
        const openingElmtPath = path.get('openingElement');
        const meta = openingElmtPath.node._meta;
        const tag = openingElmtPath.node.name;
        const tagName = tag.value; // (This will be null for customElements since is an Identifier constructor)
        const children = buildChildren(path.node, path, state);
        const attribs = openingElmtPath.node.attributes;

        // For templates, we dont need the element call
        if (tagName === CONST.TEMPLATE_TAG) {
            meta.isTemplate = true;
            children._meta = meta;
            return children;
        }

        // Slots transform
        if (meta.isSlotTag) {
            const slotName = meta.maybeSlotNameDef || CONST.DEFAULT_SLOT_NAME;
            const slotSet = t.identifier(`${SLOT_SET}.${slotName}`);
            const slot = t.logicalExpression('||', slotSet, children);
            slot._meta = meta;
            return slot;
        }

        const exprTag = applyPrimitive(tag._primitive || CREATE_ELEMENT);
        const args = [tag, attribs, children];

        if (tag._customElement) {
            groupSlots(attribs, children); // changes attribs as side-effect
            args.unshift(t.stringLiteral(tag._customElement));
            args.pop(); //remove children
        }


        // Return null when no attributes
        // TODO: Fix engine to support either null or undefined here
        // if (!attribs.properties || !attribs.properties.length) {
            //attribs.type = 'NullLiteral';
        // }

        const createElementExpression = t.callExpression(exprTag, args);
        createElementExpression._meta = meta; // Push metadata up
        return createElementExpression;
    }

    function convertJSXIdentifier(node, meta, path, state) {
        const hasIsDirective = DIRECTIVES.is in meta.directives;
        // <a.b.c/>
        if (t.isJSXMemberExpression(node)) {
            throw path.buildCodeFrameError('Member expressions not supported');
        }

        // TODO: Deprecate this
        //<a:b/>
        if (t.isJSXNamespacedName(node)) {
            const name = node.namespace.name + CONST.MODULE_SYMBOL + node.name.name;
            const devName = node.namespace.name + '$' + node.name.name;
            const id = state.file.addImport(name, 'default', devName);
            metadata.addComponentDependency(name);
            id._primitive = VIRTUAL_ELEMENT;
            return id;
        }

        // <div> -- Any name for now will work
        if (t.isJSXIdentifier(node) && (hasIsDirective || node.name.indexOf('-') !== -1)) {
            const originalName = node.name;
            const name = DIRECTIVES.is in meta.directives ? meta.rootElement : originalName;
            const devName = toCamelCase(name);
            const id = state.file.addImport(name.replace('-', CONST.MODULE_SYMBOL), 'default', devName);
            metadata.addComponentDependency(name);
            meta.isCustomElementTag = true;
            id._primitive = CUSTOM_ELEMENT;
            id._customElement = originalName;
            return id;
        }

        if (isSVG(node.name)) {
            meta.isSvgTag = true;
        }

        meta.isSlotTag = node.name === CONST.SLOT_TAG;

        return t.stringLiteral(node.name);
    }

    function isDataAttributeName(name) {
        return name.startsWith(CONST.DATA_ATTRIBUTE_PREFIX);
    }

    function isNSAttributeName(name) {
        return name.indexOf(':') !== -1;
    }

    // https://html.spec.whatwg.org/multipage/dom.html#dom-dataset
    function fomatDataAttributeName(originalName) {
        let name = originalName.slice(CONST.DATA_ATTRIBUTE_PREFIX.length);
        return name.replace(/-[a-z]/g, match => match[1].toUpperCase());
    }

    function isDirectiveName(name) {
        return name === MODIFIERS.if || name === MODIFIERS.for || name === MODIFIERS.else || name === DIRECTIVES.is;
    }

    function transformProp(prop, path, elementMeta, state) {
        const meta = prop._meta;
        const directive = meta.directive;
        const scopedVars = elementMeta.scoped;
        let valueName = prop.key.value || prop.key.name; // Identifier|Literal
        let valueNode = prop.value;
        let inScope = false;

        if (meta.expressionContainer) {
            prop.key._ignore = true;
            path.traverse(BoundThisVisitor, { customScope : state.customScope });
            valueNode = path.node.value;
        }

        if (directive) {
            let rootMember;
            if (t.isStringLiteral(valueNode)) {
                rootMember = getMemberFromNodeStringLiteral(valueNode);
                inScope = scopedVars.indexOf(rootMember) !== -1;
                valueNode = transformBindingLiteral(valueNode.value, inScope);

                if (!inScope && directive === DIRECTIVES.set || directive === DIRECTIVES.repeat) {
                    metadata.addUsedId(rootMember, state, t);
                }
            }

            if (directive === DIRECTIVES.bind) {
                const bindExpression = t.callExpression(t.memberExpression(valueNode, t.identifier('bind')), [t.identifier(CMP_INSTANCE)]);
                valueNode = memoizeSubtree(bindExpression, path);
            }

        } else {
            if (valueName === 'style') {
                valueNode = t.valueToNode(parseStyles(prop.value.value));
            }
        }

        if (isDataAttributeName(valueName)) {
            meta.dataset = true;
            valueName = t.stringLiteral(fomatDataAttributeName(valueName));
        } else if (isNSAttributeName(valueName)) {
            meta.svg = true;
            valueName = t.stringLiteral(valueName);
        } else if (elementMeta.isCustomElementTag) {
            valueName = t.identifier(toCamelCase(valueName));
        } else {
            valueName = isTopLevelProp(valueName) || !needsComputedCheck(valueName) ? t.identifier(valueName) : t.stringLiteral(valueName);
        }

        prop.key = valueName;
        prop.value = valueNode;
        return prop;
    }

    function transformAndGroup(props: any, elementMeta: any, path: any, state: any): any {
        const finalProps = [];
        const propKeys = {};

        function addGroupProp(key: string, value: any) {
            let group = propKeys[key];
            if (!group) {
                group = t.objectProperty(t.identifier(key), t.objectExpression([]));
                finalProps.push(group);
                propKeys[key] = group;
            }
            group.value.properties.push(value);
        }

        props.forEach((prop: any, index: number) => {
            const name = prop.key.value || prop.key.name; // Identifier|Literal
            const meta = prop._meta;

            prop = transformProp(prop, path[index], elementMeta, state);
            let groupName = CONST.ATTRS;

            if (isTopLevelProp(name)) {
                finalProps.push(prop);
                return;
            }

            if (elementMeta.isCustomElementTag) {
                groupName = CONST.PROPS;
            }

            if (meta.isSlot) {
                return;
            }

            if (meta.directive && isDirectiveName(name)) {
                elementMeta[name] = prop.value;
                return;
            }

            if (meta.dataset) {
                groupName = CONST.DATASET;
            }

            if (meta.event) {
                groupName = 'on';
            }

            addGroupProp(groupName, prop);
        });

        const objExpression = t.objectExpression(finalProps);
        objExpression._meta = elementMeta;
        return objExpression;
    }

    // TODO: Clean this with a simpler merge
    function groupAttrMetadata(metaGroup, meta) {
        if (meta.directive) {
            metaGroup.directives[meta.directive] = meta.directive;
        }

        if (meta.modifier) {
            metaGroup.modifiers[meta.modifier] = meta.modifier;
        }

        if (meta.rootElement) {
            metaGroup.rootElement = meta.rootElement;
        }

        if (meta.isSlot) {
            metaGroup.hasSlot = meta.isSlot;
            metaGroup.slot = meta.slot;
        }

        if (meta.maybeSlotNameDef) {
            metaGroup.maybeSlotNameDef = meta.maybeSlotNameDef;
        }

        if (meta.inForScope) {
            metaGroup.inForScope = meta.inForScope;
            metaGroup.scoped.push(...meta.inForScope);
        }
        return metaGroup;
    }

    function memoizeSubtree(expression, path) {
        const root = path.find((path) => path.isProgram());
        const id = path.scope.generateUidIdentifier("m");
        const m = memoizeLookup({ ID: id });
        const hoistedMemoization = memoizeFunction({ ID: id, STATEMENT: expression });
        hoistedMemoization._memoize = true;
        root.unshiftContainer('body', hoistedMemoization);
        return m.expression;
    }

    function normalizeAttributeName(node: BabelNodeJSXIdentifier | BabelNodeJSXNamespacedName): { meta: MetaConfig, node: BabelNodeStringLiteral | BabelNodeIdentifier }  {
        const meta: MetaConfig = { directive: null, modifier: null, event: null, scoped: null, isExpression: false };

        if (t.isJSXNamespacedName(node)) {
            const dNode: BabelNodeJSXIdentifier = node.namespace;
            const mNode: BabelNodeJSXIdentifier = node.name;

            // Transform nampespaced svg attrs correctly
            if (isSvgNsAttribute(dNode.name)) {
                mNode.name = `${dNode.name}:${mNode.name}`;
                dNode.name = '';
            }

            if (dNode.name in DIRECTIVES) {
                meta.directive = DIRECTIVES[dNode.name];
            }

            if (mNode.name in MODIFIERS) {
                meta.modifier = MODIFIERS[mNode.name];
            }

            if (mNode.name.indexOf(DIRECTIVES.on) === 0) {
                const rawEventName = mNode.name.substring(2);
                mNode.name = meta.event = rawEventName;
            }

            node = mNode;
        }

        // Autowire bind for properties prefixed with on
        if (node.name.indexOf(DIRECTIVES.on) === 0) {
            const rawEventName = node.name.substring(2);
            node.name = meta.event = rawEventName;
            meta.directive = DIRECTIVES.bind;

        // Special is directive
        } else if (node.name === DIRECTIVES.is) {
            meta.directive = DIRECTIVES.is;

        // Potential slot name
        } else if (node.name === 'name') {
            meta.hasNameAttribute = true;

        // Slot
        } else if (node.name === 'slot') {
            meta.isSlot = true;
        }

        // Replace node with an identifier
        if (t.isValidIdentifier(node.name)) {
            node.type = 'Identifier';
        } else {
            node = t.stringLiteral(node.name);
        }

        // Return nodeType: Identifier|StringLiteral
        return { node, meta };
    }

    function normalizeAttributeValue(node: any, meta: any): BabelNode {
         node = node || t.booleanLiteral(true);

         if (t.isJSXExpressionContainer(node)) {
             node = node.expression;
             meta.expressionContainer = true;
         } else {
            t.assertLiteral(node);
         }

        if (meta.directive === DIRECTIVES.is) {
            meta.rootElement = node.value;
        }

        if (meta.hasNameAttribute) {
            // Save the value name so in the slots is easy to transform going up
            meta.maybeSlotNameDef = node.value;
        }

        if (meta.isSlot && !t.isBooleanLiteral(node)) {
            meta.slot = node.value;
        }

        if (meta.directive === DIRECTIVES.repeat) {
            const parsedValue = parseForStatement(node.value);
            node.value = parsedValue.for;
            meta.inForScope = parsedValue.args;
        }

        return node;
    }
}
