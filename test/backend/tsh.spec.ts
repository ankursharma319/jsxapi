import TSHBackend from '../../src/backend/tsh';
import {
  ILLEGAL_VALUE,
  INVALID_PATH,
  PARAMETER_ERROR,
} from '../../src/xapi/exc';

import MockTransport from '../mock_transport';
import { JSONParser } from '../../src/json-parser';
import { XapiResponse, XapiRequest } from '../../src/xapi/types';

describe('TSH Backend', () => {
  let parser: JSONParser;
  let transport: MockTransport;
  let tsh: TSHBackend;

  beforeEach(() => {
    transport = new MockTransport();
    tsh = new TSHBackend(transport);
    parser = (tsh as any).parser;
    transport.stubBackend(tsh);
  });

  describe('constructor', () => {
    it('disables echo', () =>
      transport.sendWelcomeText().then(() => {
        expect(transport.writeBuffer).toEqual(['echo off']);
      }));

    it('sets xpreferences', () =>
      transport.init().then(() => {
        expect(transport.writeBuffer).toEqual([
          'xpreferences outputmode json',
          'echo off',
        ]);
      }));

    it('resolves `.isReady` when ready', () => {
      transport.init();
      return tsh.isReady.then((result) => {
        expect(result).toEqual(true);
      });
    });

    it('emits "ready" event when ready', (done) => {
      tsh.on('ready', done);
      transport.init();
    });
  });

  describe('tsh sets state to initializing', () => {
    it('on "OK" alone from transport', (done) => {
      tsh.on('initializing', done);
      transport.send('OK');
    });

    it('on "OK" in a complex string from transport', (done) => {
      tsh.on('initializing', done);
      transport.send(`
Welcome to somehost
Cisco Codec Release ce 9.2.2 3a892a1 2017-11-30
SW Release Date: 2017-11-30 13:06:59, matchbox
*r Login successful

OK

Last login from 10.228.101.226 at 2017-12-01 13:14:47
      `);
    });

    it('on "OK" with unfortunate chunking', (done) => {
      tsh.on('initializing', done);
      transport.send(`
Welcome to somehost
Cisco Codec Release ce 9.2.2 3a892a1 2017-11-30
SW Release Date: 2017-11-30 13:06:59, matchbox
*r Login successful

O`);
      transport.send(`K

Last login from 10.228.101.226 at 2017-12-01 13:14:47
      `);
    });
  });

  describe('events', () => {
    it('emits "close" on transport close', () => {
      const closeSpy = jest.fn();

      tsh.on('close', closeSpy);

      transport.emit('close');

      expect(closeSpy).toHaveBeenCalledTimes(1);
    });

    it('emits "error" on transport error', () => {
      const error = new Error('some error');
      const errorSpy = jest.fn();

      tsh.on('error', errorSpy);

      transport.emit('error', error);

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0]).toContain(error);
    });

    it('emits "error" on parser error', () => {
      const error = new Error('some error');
      const errorSpy = jest.fn();

      tsh.on('error', errorSpy);

      parser.emit('error', error);

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0]).toContain(error);
    });
  });

  describe('when parser emits "data" response from', () => {
    let spy: jest.Mock;
    interface TestCase {
      id?: string;
      method?: string;
      params?: any;
      result?: string | boolean;
    }

    type Omit<T, K> = Pick<T, Exclude<keyof T, K>>;
    const createMessage = (message: TestCase) => {
      const request: Omit<XapiRequest, 'method'> = Object.assign(
        { jsonrpc: '2.0', id: 'request-1' },
        message,
      );
      return request as XapiRequest;
    };

    beforeEach(() => {
      spy = jest.fn();
      tsh.on('data', spy);
      return transport.init();
    });

    const testCases: {
      request: TestCase;
      name: string;
      response: string;
      expected: any;
    }[] = [
      // xCommand
      {
        name: 'xCommand, it handles empty successful command result',
        request: { method: 'xCommand/Audio/Volume/Increase' },
        response: `
          {
            "CommandResponse": {
              "VolumeIncreaseResult": {
                "status": "OK"
              }
            }
            ,"ResultId": "request-1"
          }
        `,
        expected: { result: { status: 'OK' } },
      },
      {
        name: 'xCommand, it handles XPath error',
        request: { method: 'xCommand/Dila' },
        response: `
          {
            "CommandResponse": {
              "Result": {
                "status": "Error",
                "Reason": { "Value": "Unknown command" },
                "XPath": { "Value": "/Dila" }
              }
            }
            ,"ResultId": "request-1"
          }
        `,
        expected: {
          error: {
            code: INVALID_PATH,
            message: 'Unknown command',
            data: { xpath: '/Dila' },
          },
        },
      },
      {
        name: 'xCommand, it handles ParameterError',
        request: { method: 'xCommand/Dial' },
        response: `
          {
            "CommandResponse": {
              "DialResult": {
                "status": "ParameterError"
              }
            }
            ,"ResultId": "request-1"
          }
        `,
        expected: {
          error: {
            code: PARAMETER_ERROR,
            message: 'Invalid or missing parameters',
          },
        },
      },
      {
        name: 'xCommand, it extracts nested command result',
        request: {
          method: 'xCommand/Dial',
          params: { Number: 'user@example.com' },
        },
        response: `
          {
            "CommandResponse": {
              "DialResult": {
                "status": "OK",
                "CallId": {
                  "Value": "2"
                },
                "ConferenceId": {
                  "Value": "1"
                }
              }
            }
            ,"ResultId": "request-1"
          }
        `,
        expected: {
          result: { status: 'OK', CallId: '2', ConferenceId: '1' },
        },
      },
      {
        name: 'xCommand, it collapses "Value" nodes',
        request: { method: 'xCommand/Phonebook/Search' },
        response: `
          {
            "CommandResponse": {
              "PhonebookSearchResult": {
                "status": "OK",
                "id": "1",
                "Contact": [{
                  "id": "1",
                  "Name": {
                    "Value": "asdf"
                  },
                  "ContactId": {
                    "Value": "localContactId-2"
                  },
                  "FolderId": {
                    "Value": "localGroupId-1"
                  },
                  "ContactMethod": [{
                    "id": "1",
                    "ContactMethodId": {
                      "Value": "1"
                    },
                    "Number": {
                      "Value": "asdf"
                    },
                    "CallType": {
                      "Value": "Video"
                    }
                  }]
                }]
              }
            }
          ,"ResultId": "request-1"
          }
        `,
        expected: {
          result: {
            id: '1',
            status: 'OK',
            Contact: [
              {
                id: '1',
                Name: 'asdf',
                ContactId: 'localContactId-2',
                FolderId: 'localGroupId-1',
                ContactMethod: [
                  {
                    id: '1',
                    ContactMethodId: '1',
                    Number: 'asdf',
                    CallType: 'Video',
                  },
                ],
              },
            ],
          },
        },
      },
      // xGet
      {
        name: 'xGet, it finds the leaf node of the result',
        request: {
          method: 'xGet',
          params: { Path: ['Status', 'SystemUnit', 'Uptime'] },
        },
        response: `
          {
            "Status": {
              "SystemUnit": {
                "Uptime": {
                  "Value": "29038"
                }
              }
            }
            ,"ResultId": "request-1"
          }
        `,
        expected: { result: '29038' },
      },
      {
        name: 'xGet, handles invalid path',
        request: {
          method: 'xGet',
          params: { Path: ['Configuration', 'Foo', 'Bar'] },
        },
        response: `
          {
            "CommandResponse": {
              "Configuration":{
                "status":"Error",
                "id":"1",
                "Reason":{
                  "Value":"No match on address expression"
                },
                "XPath":{
                  "Value":"Configuration/Audio/Foo"
                }
              }
            }
            ,"ResultId": "request-1"
          }
        `,
        expected: {
          error: {
            code: INVALID_PATH,
            message: 'No match on address expression',
            data: { xpath: 'Configuration/Audio/Foo' },
          },
        },
      },
      {
        name: 'xGet, it handles array indices',
        request: {
          method: 'xGet',
          params: {
            Path: [
              'Status',
              'Video',
              'Layout',
              'Site',
              1,
              'Output',
              1,
              'FamilyName',
            ],
          },
        },
        response: `
          {
            "Status":{
              "Video":{
                "Layout":{
                  "Site":[{
                    "id":"1",
                    "Output":[{
                      "id":"1",
                      "FamilyName":{
                        "Value":"overlay"
                      }
                    }]
                  }]
                }
              }
            }
            ,"ResultId": "request-1"
          }
        `,
        expected: { result: 'overlay' },
      },
      // xSet
      {
        name: 'xSet, gives empty responses',
        request: {
          method: 'xSet',
          params: {
            Path: ['Configuration', 'Audio', 'DefaultVolume'],
            Value: 50,
          },
        },
        response: `
          {
            "ResultId": "request-1"
          }
        `,
        expected: { result: null },
      },
      {
        name: 'xSet, handles value error',
        request: {
          method: 'xSet',
          params: {
            Path: ['Configuration', 'Audio', 'DefaultVolume'],
            Value: 'asdf',
          },
        },
        response: `
          {
            "Configuration":{
              "Audio":{
                "DefaultVolume":{
                  "error":"True",
                  "Value":"Illegal value"
                }
              }
            },
            "ResultId": "request-1"
          }
        `,
        expected: {
          error: {
            code: ILLEGAL_VALUE,
            message: 'Illegal value',
          },
        },
      },
      // Feedback
      {
        name: 'register feedback',
        request: {
          method: 'xFeedback/Subscribe',
          params: { Query: ['Status', 'Audio', 'Volume'] },
        },
        response: `
          {
            "ResultId": "request-1"
          }
        `,
        expected: { result: { Id: 0 } },
      },
    ];

    testCases.forEach((test) => {
      it(test.name, () => {
        jest.spyOn(tsh, 'send').mockImplementation(() => {
          parser.emit('data', JSON.parse(test.response));
        });

        return tsh.execute(createMessage(test.request)).then(() => {
          const expected = createMessage(test.expected);
          expect(spy).toHaveBeenCalledWith(expected);
        });
      });
    });

    it('xFeedback/Subscribe wraps indexes in [<n>]', () => {
      const send = jest.spyOn(tsh, 'send').mockImplementation(() => {
        parser.emit('data', { ResultId: 'request-1' });
      });

      return tsh
        .execute({
          id: 'request-1',
          method: 'xFeedback/Subscribe',
          params: {
            Query: ['Status', 'Video', 'Layout', 'Prediction', 'Site', 1],
          },
          jsonrpc: '2.0',
        })
        .then(() => {
          expect(send.mock.calls[0]).toEqual([
            'request-1',
            'xfeedback register /Status/Video/Layout/Prediction/Site[1]',
            undefined
          ]);
        });
    });

    it('deregister feedback', () => {
      const responses = [
        '{"ResultId": "request-1"}',
        '{"ResultId": "request-2"}',
      ];

      jest.spyOn(tsh, 'send').mockImplementation(() => {
        parser.emit('data', JSON.parse(responses.shift()!));
      });

      return tsh
        .execute(
          createMessage({
            id: 'request-1',
            method: 'xFeedback/Subscribe',
            params: { Query: ['Status', 'Audio', 'Volume'] },
          }),
        )
        .then(() =>
          tsh.execute(
            createMessage({
              id: 'request-2',
              method: 'xFeedback/Unsubscribe',
              params: { Id: 0 },
            }),
          ),
        )
        .then(() => {
          const expected = createMessage({ id: 'request-2', result: true });
          expect(spy.mock.calls[1]).toContainEqual(expected);
        });
    });

    it('feedback event', () => {
      parser.emit(
        'data',
        JSON.parse(`
        {
          "Status": {
            "Audio": {
              "id": "",
              "Volume": {
                "Value": "75"
              }
            }
          }
        }
      `),
      );

      expect(spy).toHaveBeenCalledWith({
        jsonrpc: '2.0',
        method: 'xFeedback/Event',
        params: { Status: { Audio: { id: '', Volume: '75' } } },
      });
    });
  });

  describe('.execute()', () => {
    const defaultProps = {
      jsonrpc: '2.0',
      id: 'request-1',
    };

    const extensionsXML =
      '<Extensions>\n' +
      '  <Version>1.1</Version>\n' +
      '  <Panel>\n' +
      '    <Icon>Lightbulb</Icon>\n' +
      '    <Type>Statusbar</Type>\n' +
      '  </Panel>\n' +
      '</Extensions>';

    const testCases = [
      // xCommand
      {
        name: '"xCommand" without params',
        request: { method: 'xCommand/Standby/Deactivate' },
        expected: 'xCommand Standby Deactivate | resultId="request-1"',
      },
      {
        name: '"xCommand" with params',
        request: {
          method: 'xCommand/Dial',
          params: { Number: 'user@example.com' },
        },
        expected:
          'xCommand Dial Number: "user@example.com" | resultId="request-1"',
      },
      {
        name: '"xCommand" with number argument',
        request: {
          method: 'xCommand/Video/Input/SetVideoMainSource',
          params: { SourceId: 1 },
        },
        expected:
          'xCommand Video Input SetVideoMainSource SourceId: 1 | resultId="request-1"',
      },
      {
        name: '"xCommand" with boolean argument',
        request: {
          method: 'xCommand/Some/Command',
          params: { Enabled: false },
        },
        expected: 'xCommand Some Command Enabled: False | resultId="request-1"',
      },
      {
        name: '"xCommand" with string containing quotes',
        request: {
          method: 'xCommand/Message/Send',
          params: { Text: 'foo "bar" bin' },
        },
        expected:
          'xCommand Message Send Text: "foo \\"bar\\" bin" | resultId="request-1"',
      },
      {
        name: '"xCommand" with array of strings containing quotes',
        request: {
          method: 'xCommand/Message/Send',
          params: { Text1: 'foo "bar" bin', Text2: 'baz "boo" boing' },
        },
        expected:
          'xCommand Message Send Text1: "foo \\"bar\\" bin" Text2: "baz \\"boo\\" boing" | resultId="request-1"',
      },
      {
        name: '"xCommand" with array params',
        request: {
          method: 'xCommand/UserManagement/User/Add',
          params: { Username: 'user', Role: ['Admin', 'User'] },
        },
        expected:
          'xCommand UserManagement User Add Role: "Admin" Role: "User" Username: "user" | resultId="request-1"',
      },
      {
        name: '"xCommand" with multi-line body',
        request: {
          method: 'xCommand/UserInterface/Extensions/Set',
          params: {
            ConfigId: 'example',
            body: extensionsXML,
          },
        },
        expected: [
          '{208} ', // <-- NB: Space before newline
          'xCommand UserInterface Extensions Set ConfigId: "example" | resultId="request-1"',
          extensionsXML,
        ].join('\n'),
      },
      {
        name: '"xCommand" with single character body',
        request: {
          method: 'xCommand/HttpClient/Post',
          params: {
            Url: 'https://example.com',
            body: '-',
          },
        },
        expected: [
          '{77} ', // <-- NB: Space before newline
          'xCommand HttpClient Post Url: "https://example.com" | resultId="request-1"',
          '-',
        ].join('\n'),
      },
      {
        name: '"xCommand" with empty body',
        request: {
          method: 'xCommand/HttpClient/Post',
          params: {
            Url: 'https://example.com',
            body: '',
          },
        },
        expected: [
          '{76} ', // <-- NB: Space before newline
          'xCommand HttpClient Post Url: "https://example.com" | resultId="request-1"',
        ].join('\n'),
      },
      {
        name: '"xCommand" with non-ascii body`',
        request: {
          method: 'xCommand/HttpClient/Post',
          params: {
            Url: 'https://example.com',
            body: '(╯°□°)╯︵ ┻━┻',
          },
        },
        expected: [
          '{104} ', // <-- NB: Space before newline
          'xCommand HttpClient Post Url: "https://example.com" | resultId="request-1"',
          '(╯°□°)╯︵ ┻━┻',
        ].join('\n'),
      },
      // xDoc
      {
        name: '"xDoc" for top-level',
        request: {
          method: 'xDoc',
          params: {
            Path: ['Configuration'],
            Type: 'Schema',
          },
        },
        expected: 'xDocument Format: "JSON" Path: "Configuration" Schema: "True" | resultId="request-1"',
      },
      {
        name: '"xDoc" for sub-path',
        request: {
          method: 'xDoc',
          params: {
            Path: ['Status', 'Audio', 'Volume'],
            Type: 'Schema',
          },
        },
        expected: 'xDocument Format: "JSON" Path: "Status/Audio/Volume" Schema: "True" | resultId="request-1"',
      },
      // xGet
      {
        name: '"xGet" for plain config path',
        request: {
          method: 'xGet',
          params: { Path: ['Configuration', 'SystemUnit', 'Name'] },
        },
        expected: 'xConfiguration SystemUnit Name | resultId="request-1"',
      },
      {
        name: '"xGet" for plain status path',
        request: {
          method: 'xGet',
          params: { Path: ['Status', 'SystemUnit', 'Uptime'] },
        },
        expected: 'xStatus SystemUnit Uptime | resultId="request-1"',
      },
      // xSet
      {
        name: '"xSet" for configuration value',
        request: {
          method: 'xSet',
          params: {
            Path: ['Configuration', 'SystemUnit', 'Name'],
            Value: 'My System',
          },
        },
        expected:
          'xConfiguration SystemUnit Name: "My System" | resultId="request-1"',
      },
      // xFeedback/Subscribe
      {
        name: '"xFeedback/Subscribe" for status path',
        request: {
          method: 'xFeedback/Subscribe',
          params: {
            Query: ['Status', 'Audio', 'Volume'],
          },
        },
        expected:
          'xfeedback register /Status/Audio/Volume | resultId="request-1"',
      },
    ];

    testCases.forEach(({ name, request, expected }) => {
      it(name, () =>
        transport
          .init()
          .then(() => {
            tsh.execute(Object.assign(defaultProps, request));
          })
          .then(() => {
            expect(transport.writeBuffer[0]).toEqual(expected);
          }),
      );
    });

    it('"xCommand" with invalid parameter values (object)', () => {
      transport.init().then(() =>
        tsh.execute(
          Object.assign(defaultProps, {
            method: 'xCommand/Dial',
            params: {
              Number: { Foo: ['bar'] },
            },
          }),
        ),
      );

      return new Promise((resolve) => {
        tsh.on('data', resolve);
      }).then((error: any) => {
        expect((error as XapiResponse).error.message).toMatch(
          /invalid value.*foo.*bar/i,
        );
      });
    });

    it('"xConfiguration" with invalid value', () => {
      transport.init().then(() =>
        tsh.execute(
          Object.assign(defaultProps, {
            method: 'xSet',
            params: {
              Path: ['Configuration', 'SystemUnit', 'Name'],
              Value: { Foo: ['bar'] },
            },
          }),
        ),
      );

      return new Promise((resolve) => {
        tsh.on('data', resolve);
      }).then((error: any) => {
        expect((error as any).error.message).toMatch(
          /invalid value.*foo.*bar/i,
        );
      });
    });

    it('"xFeedback/Unsubscribe" for status path', () => {
      const expected =
        'xfeedback deregister /Status/Audio/Volume | resultId="request-2"';

      return transport
        .init()
        .then(() => {
          tsh.execute(
            Object.assign(defaultProps, {
              id: 'request-1',
              method: 'xFeedback/Subscribe',
              params: {
                Query: ['Status', 'Audio', 'Volume'],
              },
            }),
          );
        })
        .then(() => {
          transport.send('{"ResultId":"request-1"}');
        })
        .then(() => {
          tsh.execute(
            Object.assign(defaultProps, {
              id: 'request-2',
              method: 'xFeedback/Unsubscribe',
              params: { Id: 0 },
            }),
          );
        })
        .then(() => {
          expect(transport.writeBuffer[0]).toEqual(expected);
        });
    });
  });
});
