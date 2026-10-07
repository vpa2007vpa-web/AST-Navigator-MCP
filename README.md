# AST-Navigator-MCP

Servidor MCP (Model Context Protocol) en TypeScript que permite a un modelo de lenguaje **explorar el Árbol de Sintaxis Abstracta (AST)** de repositorios JavaScript/TypeScript locales usando **Tree-sitter**, sin tener que leer archivos enteros.

- `get_file_structure`: esquema de un archivo (imports, clases con propiedades y métodos, funciones, interfaces/types/enums) con rangos de línea y firmas.
- `find_definition`: localiza dónde se **define** un símbolo (clase, función, método, interface, type, enum) dentro de un directorio, de forma recursiva.

Lenguajes soportados: `.js .mjs .cjs .jsx .ts .mts .cts .tsx` (incluye `.d.ts`).

---

## Requisitos

- Node.js **22 o superior**.
- Windows, macOS o Linux (x64/arm64). Tree-sitter se distribuye con binarios precompilados para estas plataformas: **no hace falta compilador de C++** ni Visual Studio Build Tools.

## Instalación

```bash
npm install      # instala dependencias y compila a ./dist (script "prepare")
npm test         # compila y ejecuta la batería completa (51 tests: e2e + regresión de seguridad)
```

## Conectarlo a un cliente MCP

El servidor habla MCP por **stdio**. Argumentos posicionales opcionales = **raíces permitidas** (sandbox): si se indica alguna, cualquier ruta fuera de ellas se rechaza y las rutas relativas se resuelven contra la primera.

Configuración típica (`claude_desktop_config.json`, Cursor, etc.) en Windows:

```json
{
  "mcpServers": {
    "ast-navigator": {
      "command": "node",
      "args": [
        "C:\\path\\to\\AST-Navigator-MCP\\dist\\index.js",
        "C:\\ruta\\a\\tu\\repositorio"
      ]
    }
  }
}
```

Probarlo de forma interactiva con MCP Inspector:

```bash
npx @modelcontextprotocol/inspector node dist/index.js C:\ruta\a\tu\repositorio
```

Opciones de línea de comandos: `--help`, `--version`. Variable de entorno `AST_NAVIGATOR_LOG_LEVEL` = `debug | info | warn | error` (por defecto `info`).

---

## Herramientas

### `get_file_structure`

| Parámetro        | Tipo                     | Descripción                                                     |
|------------------|--------------------------|-----------------------------------------------------------------|
| `filePath`       | string (obligatorio)     | Archivo a analizar. Se recomienda ruta absoluta.                |
| `responseFormat` | `"markdown"` \| `"json"` | `markdown` (por defecto): esquema compacto. `json`: objeto completo. |

Ejemplo de salida `markdown`:

```text
# C:\repo\src\services\UserService.ts
typescript | 42 lines | 3 imports | 1 class | 1 function | 1 type

## Imports
- L1 import 'node:crypto': { randomUUID }
- L2 import type '../models/user.js': { CreateUserInput, User }
- L3 import '../db/Repository.js': { Repository }

## Classes
- L10-36 export class UserService extends Repository<User> implements Disposable
  - properties: private readonly cache; static instances
  - L14-17 constructor(private readonly options: UserServiceOptions)
  - L19-23 async create(input: CreateUserInput): Promise<User>
  - L29-31 get size(): number

## Functions
- L38-42 export function createUserService(options: UserServiceOptions): UserService
```

Además del texto, la respuesta incluye siempre `structuredContent` tipado (validado contra el `outputSchema`).

### `find_definition`

| Parámetro        | Tipo                                   | Por defecto          |
|------------------|----------------------------------------|----------------------|
| `name`           | string — p. ej. `UserService`, `parseConfig` o `UserService.create` | — |
| `directory`      | string                                 | primera raíz permitida |
| `matchMode`      | `"exact"` \| `"prefix"` \| `"contains"` | `"exact"`            |
| `caseSensitive`  | boolean                                | `true`               |
| `kinds`          | `class, function, method, interface, type_alias, enum` | todos |
| `limit` / `offset` | paginación (1–200)                   | `50` / `0`           |
| `responseFormat` | `"markdown"` \| `"json"`               | `"markdown"`         |

Busca sobre **declaraciones parseadas**, no sobre texto: llamadas, comentarios y strings nunca dan falsos positivos. Resultados ordenados por relevancia (coincidencia exacta primero), luego ruta y línea. Ignora `node_modules`, `dist`, `build`, `out`, `coverage`, `vendor`, directorios ocultos (`.git`, `.next`…), enlaces simbólicos y bundles minificados.

### Errores

Los errores esperados devuelven `isError: true` con un texto accionable:

```text
Error [FILE_NOT_FOUND]: Path does not exist: C:\repo\src\nope.ts
Hint: Check the spelling and use an absolute path. find_definition can locate files that declare a given symbol.
```

Códigos: `FILE_NOT_FOUND`, `PERMISSION_DENIED`, `NOT_A_FILE`, `NOT_A_DIRECTORY`, `FILE_TOO_LARGE`, `UNSUPPORTED_LANGUAGE`, `PATH_OUTSIDE_ROOTS`, `INVALID_PATH`, `MISSING_DIRECTORY`, `READ_FAILED`, `PARSE_FAILED`. Los argumentos inválidos los rechaza Zod antes de ejecutar la herramienta.

---

## Arquitectura

```text
src/
├── index.ts                         Punto de entrada: guards de proceso + arranque
├── constants.ts                     Todos los límites operativos en un único sitio
├── errors.ts                        AstNavigatorError (code + hint) y type guards
├── server/
│   ├── AstNavigatorServer.ts        Clase principal: McpServer + registro de tools + ciclo de vida
│   ├── ResilientStdioServerTransport.ts  Transporte stdio endurecido ante payloads malformados
│   ├── config.ts                    CLI (--help, --version, raíces permitidas) validada con Zod
│   ├── logger.ts                    Logger estructurado solo a stderr + redirección de console
│   └── processGuards.ts             uncaughtException, unhandledRejection, EPIPE, señales
├── parser/
│   ├── index.ts                     API pública: extract_file_structure(), analyzeSource()
│   ├── model.ts                     Contrato de datos (esquemas Zod → tipos DeepReadonly)
│   ├── languages.ts                 Registro extensión → gramática Tree-sitter
│   ├── treeSitterParser.ts          Instancias de Parser (una por lenguaje, lazy)
│   ├── fileReader.ts                Lectura segura con errores tipados (ENOENT, EACCES…)
│   ├── structureExtractor.ts        AST → FileStructure (imports, clases, funciones, tipos)
│   └── definitions.ts               FileStructure → lista plana de definiciones
└── tools/
    ├── index.ts                     registerTools()
    ├── schemas.ts                   Esquemas Zod de entrada/salida + tipos z.infer
    ├── getFileStructure.ts          Tool get_file_structure
    ├── findDefinition.ts            Tool find_definition (búsqueda + ranking + paginación)
    ├── pathPolicy.ts                Resolución de rutas y sandbox de raíces
    ├── directoryWalker.ts           Recorrido recursivo determinista
    ├── formatters.ts                Salida markdown compacta
    ├── responses.ts                 Construcción uniforme de resultados y límite de caracteres
    └── context.ts                   Dependencias inyectadas en las tools
```

Flujo de una llamada: `stdin → ResilientStdioServerTransport → McpServer (validación Zod) → tool → PathPolicy → parser (fs + Tree-sitter) → formatter → stdout`.

## Decisiones de diseño

1. **Transporte stdio resiliente.** Con el `StdioServerTransport` del SDK, un mensaje de más de 10 MiB cierra el transporte y el proceso termina (verificado). `ResilientStdioServerTransport` usa el mismo formato de cable (JSON delimitado por saltos de línea, validado con `JSONRPCMessageSchema` del SDK) pero descarta el frame y responde según JSON-RPC 2.0: `-32700` para JSON inválido y `-32600` para mensajes no válidos o demasiado grandes. La sesión sigue viva, y la memoria también está acotada: las escrituras pasan por una cola de un solo escritor (un único listener `drain`, tope de 32 MiB; pasado el tope `send()` falla en vez de bufferizar), stdin se pausa mientras stdout está saturado, una racha de frames inválidos solo genera 64 respuestas de error (se rearma con el primer mensaje válido) y los `id` de más de 256 caracteres no se reflejan. Una ráfaga de 200.000 líneas malformadas retiene ~0,1 MiB de heap (antes del endurecimiento, más de 150 MiB).
2. **Errores globales contenidos.** Las excepciones dentro de las tools se convierten en resultados `isError`; los errores de protocolo se registran vía `server.onerror`; `uncaughtException`/`unhandledRejection` se registran sin matar el proceso (el servidor es de solo lectura y sin estado compartido). El cierre de stdin, `EPIPE` en stdout y `SIGINT`/`SIGTERM` provocan un apagado limpio.
3. **stdout reservado a JSON-RPC.** Todo log va a stderr y además se sustituye la `console` global por una ligada a stderr, de modo que ni un `console.log` accidental (propio o de una dependencia) puede corromper el canal. Un test verifica que todo lo que sale por stdout es JSON válido.
4. **Zod como fuente única de verdad.** Las entradas se validan con `z.strictObject` (se rechazan campos desconocidos) y los handlers se tipan con `z.infer`. Los esquemas de salida se publican como `outputSchema` y los tipos del dominio se infieren de ellos como `DeepReadonly`. También se validan con Zod la CLI y la variable de entorno del nivel de log.
5. **Sandbox opcional por raíces.** La autoridad es la ruta **canónica** (`realpath`), así que ni `../` ni un enlace simbólico o junction permiten salir de la raíz, mientras que una raíz alcanzada a través de un enlace (p. ej. `/tmp` → `/private/tmp` en macOS) sigue funcionando. Además se comprueba la contención **léxica** sin tocar el disco: toda ruta que no esté léxicamente dentro de una raíz solo puede devolver `PATH_OUTSIDE_ROOTS`, exista o no, de modo que los códigos `FILE_NOT_FOUND`/`PERMISSION_DENIED` no sirven de oráculo para sondear qué hay fuera del sandbox. Zod rechaza antes caracteres de control y los prefijos `\\?\`/`\\.\` de Windows; el traversal no se decide en el esquema (que no conoce las raíces), sino en `PathPolicy`. La lectura usa un único descriptor (`open` + `fstat` + lectura del mismo handle), y con raíces configuradas se abre con `O_NOFOLLOW` para cerrar la ventana entre la validación y la lectura.
6. **Búsqueda eficiente.** `find_definition` aplica un pre-filtro de texto (el archivo debe contener el nombre) antes de parsear, con lecturas concurrentes acotadas. Sobre ~1.500 archivos responde en 0,3–2,3 s.
7. **Alcance del esquema: nivel superior del módulo.** Funciones anidadas y closures son detalles de implementación que solo añadirían ruido al contexto del modelo.

### Nota sobre dependencias

Solo se usan las librerías del stack: `@modelcontextprotocol/sdk`, `zod`, `tree-sitter`, `tree-sitter-javascript`, `tree-sitter-typescript` (+ `typescript` y `@types/node` como devDependencies). No se usa `tsx`: el script `dev` es `tsc --watch`.

`tree-sitter-typescript@0.23.2` (la última publicada) declara un `peerDependency` desactualizado (`tree-sitter ^0.21`), lo que hace fallar `npm install` junto a `tree-sitter@0.25`. Se resuelve con el bloque `overrides` de `package.json` (configuración de npm, no una dependencia nueva). Es seguro: su gramática usa la ABI 14, que el núcleo 0.25 soporta (ABI 13–15), y lo confirman los tests de TS/TSX.

## Scripts npm

| Script              | Acción                                                        |
|---------------------|---------------------------------------------------------------|
| `npm run build`     | Compila `src/` → `dist/`                                      |
| `npm start`         | Ejecuta `dist/index.js` (con source maps)                     |
| `npm run dev`       | Compilación incremental en modo watch                         |
| `npm run typecheck` | Comprobación de tipos sin emitir                              |
| `npm test`          | Compila y ejecuta los tests end-to-end y de regresión de seguridad (`node --test`, 60 s máx. por test) |
| `npm run clean`     | Borra `dist/`                                                 |

## Limitaciones conocidas

- Encuentra **definiciones**, no referencias/usos.
- No lee `.gitignore` (usa una lista fija de directorios ignorados).
- Las funciones envueltas (`const X = memo(() => …)`) no se detectan como funciones; tampoco se recorren los `namespace` de TypeScript.
- Archivos de más de 2 MiB se omiten; un escaneo se detiene a los 20.000 archivos (`scanTruncated: true`).
- `O_NOFOLLOW` no existe en Windows: allí la protección frente a un enlace colocado entre la validación y la lectura no aplica (la comprobación canónica sí).
- Un *hardlink* dentro de una raíz que apunte a un archivo externo es indistinguible a nivel de sistema operativo y no se puede detectar.
