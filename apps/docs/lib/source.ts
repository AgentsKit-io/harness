import { docs } from '@/.source/server'
import { loader } from 'fumadocs-core/source'

/** Every page under `content/docs/` is public: the site owns its content, so there is nothing to filter. */
export const source = loader({ baseUrl: '/docs', source: docs.toFumadocsSource() })
