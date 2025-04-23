const axios = require('axios');
const { isEnabled } = require('~/server/utils');
const { logger } = require('~/config');

const footer = `Use the context as your learned knowledge to better answer the user.

In your response, remember to follow these guidelines:
- If you don't know the answer, simply say that you don't know.
- If you are unsure how to answer, ask for clarification.
- Avoid mentioning that you obtained the information from the context.
`;

function createContextHandlers(req, userMessageContent) {
  if (!process.env.RAG_API_URL) {
    return;
  }

  const queryPromises = [];
  const processedFiles = [];
  const processedIds = new Set();
  const jwtToken = req.headers.authorization.split(' ')[1];
  const useFullContext = isEnabled(process.env.RAG_USE_FULL_CONTEXT);
  const usePublicKnowledge = isEnabled(process.env.RAG_ENABLE_PUBLIC_KNOWLEDGE);

  const query = async (file) => {
    if (useFullContext) {
      return axios.get(`${process.env.RAG_API_URL}/documents/${file.file_id}/context`, {
        headers: {
          Authorization: `Bearer ${jwtToken}`,
        },
      });
    }

    return axios.post(
      `${process.env.RAG_API_URL}/query`,
      {
        file_id: file.file_id,
        query: userMessageContent,
        k: 4,
      },
      {
        headers: {
          Authorization: `Bearer ${jwtToken}`,
          'Content-Type': 'application/json',
        },
      },
    );
  };

  // Query function for public knowledge base
  const queryPublicKnowledge = async () => {
    // Querying public knowledge base

    try {
      const response = await axios.post(
        `${process.env.RAG_API_URL}/query`,
        {
          user_id: 'public',
          query: userMessageContent,
          k: 4,
        },
        {
          headers: {
            Authorization: `Bearer ${jwtToken}`,
            'Content-Type': 'application/json',
          },
        },
      );
      // Public knowledge query response received
      return response;
    } catch (error) {
      logger.error('Public knowledge query error', {
        error: error.message,
        status: error.response?.status
      });
      throw error;
    }
  };

  const processFile = async (file) => {
    if (file.embedded && !processedIds.has(file.file_id)) {
      try {
        const promise = query(file);
        queryPromises.push(promise);
        processedFiles.push(file);
        processedIds.add(file.file_id);
      } catch (error) {
        logger.error(`Error processing file ${file.filename}:`, error);
      }
    }
  };

  const createContext = async () => {
    // Creating context

    try {
      // Query public knowledge base if enabled
      if (usePublicKnowledge) {
        try {
          const publicKnowledgePromise = queryPublicKnowledge();
          queryPromises.push(publicKnowledgePromise);
          // Added public knowledge query
        } catch (error) {
          logger.error('Error querying public knowledge base:', error);
        }
      }

      // If no queries at all, return empty context
      if (!queryPromises.length) {
        // No queries to process, returning empty context
        return '';
      }

      // If we have user files
      if (processedFiles.length > 0) {
        const oneFile = processedFiles.length === 1;
        const header = `The user has attached ${oneFile ? 'a' : processedFiles.length} file${!oneFile ? 's' : ''
          } to the conversation:`;

        const files = `${oneFile
          ? ''
          : `
      <files>`
          }${processedFiles
            .map(
              (file) => `
              <file>
                <filename>${file.filename}</filename>
                <type>${file.type}</type>
              </file>`,
            )
            .join('')}${oneFile
              ? ''
              : `
        </files>`
          }`;

        // Resolving all queries
        const resolvedQueries = await Promise.all(queryPromises);
        // All queries resolved

        // Determine if we have public knowledge results
        const hasPublicKnowledge = usePublicKnowledge;
        const publicKnowledgeResult = hasPublicKnowledge ? resolvedQueries[0] : null;
        const userFileResults = hasPublicKnowledge ? resolvedQueries.slice(1) : resolvedQueries;

        // Process user file context
        const userFilesContext =
          userFileResults.length === 0
            ? '\n\tThe semantic search did not return any results for user files.'
            : userFileResults
              .map((queryResult, index) => {
                const file = processedFiles[index];
                let contextItems = queryResult.data;

                // Processing user file result

                const generateContext = (currentContext) => {
                  const context = `
          <file>
            <filename>${file.filename}</filename>
            <context>${currentContext}
            </context>
          </file>`;
                  // Generated context for user file
                  return context;
                };

                if (useFullContext) {
                  // Using full context for user file
                  return generateContext(`\n${contextItems}`);
                }

                contextItems = queryResult.data
                  .map((item, itemIndex) => {
                    const pageContent = item[0].page_content;
                    // Processing user file context item
                    return `
            <contextItem>
              <![CDATA[${pageContent?.trim()}]]>
            </contextItem>`;
                  })
                  .join('');

                return generateContext(contextItems);
              })
              .join('');

        // Process public knowledge context if available
        let publicKnowledgeContext = '';
        // Processing public knowledge context

        if (hasPublicKnowledge && publicKnowledgeResult && publicKnowledgeResult.data && publicKnowledgeResult.data.length > 0) {
          if (useFullContext) {
            publicKnowledgeContext = `
          <knowledgeBase>
            <source>public</source>
            <context>\n${publicKnowledgeResult.data}
            </context>
          </knowledgeBase>`;
          } else {
            const contextItems = publicKnowledgeResult.data
              .map((item) => {
                const pageContent = item[0].page_content;
                return `
            <contextItem>
              <![CDATA[${pageContent?.trim()}]]>
            </contextItem>`;
              })
              .join('');

            publicKnowledgeContext = `
          <knowledgeBase>
            <source>public</source>
            <context>${contextItems}
            </context>
          </knowledgeBase>`;
          }
        }

        // Combine contexts
        const context = hasPublicKnowledge && publicKnowledgeContext
          ? publicKnowledgeContext + userFilesContext
          : userFilesContext;

        // Generating final prompt

        if (useFullContext) {
          const prompt = `${header}
          ${context}
          ${footer}`;

          // Generated full context prompt
          return prompt;
        }

        const prompt = `${header}
        ${files}

        A semantic search was executed with the user's message as the query, retrieving the following context inside <context></context> XML tags.

        <context>${context}
        </context>

        ${footer}`;

        return prompt;
      }
      // If we only have public knowledge but no files
      else if (usePublicKnowledge) {
        const resolvedQueries = await Promise.all(queryPromises);
        const publicQueryResult = resolvedQueries[0];

        if (!publicQueryResult || !publicQueryResult.data || publicQueryResult.data.length === 0) {
          return '';
        }

        let publicKnowledgeContext = '';

        if (useFullContext) {
          publicKnowledgeContext = `\n${publicQueryResult.data}`;
        } else {
          publicKnowledgeContext = publicQueryResult.data
            .map((item) => {
              const pageContent = item[0].page_content;
              return `
            <contextItem>
              <![CDATA[${pageContent?.trim()}]]>
            </contextItem>`;
            })
            .join('');
        }

        const header = 'Relevant information from the knowledge base:';

        if (useFullContext) {
          return `${header}
          <knowledgeBase>
            <source>public</source>
            <context>${publicKnowledgeContext}
            </context>
          </knowledgeBase>
          ${footer}`;
        }

        return `${header}

        A semantic search was executed with the user's message as the query, retrieving the following context inside <context></context> XML tags.

        <context>
          <knowledgeBase>
            <source>public</source>
            <context>${publicKnowledgeContext}
            </context>
          </knowledgeBase>
        </context>

        ${footer}`;
      }

      return '';
    } catch (error) {
      logger.error('Error creating context:', error);
      throw error;
    }
  };

  return {
    processFile,
    createContext,
  };
}

module.exports = createContextHandlers;
