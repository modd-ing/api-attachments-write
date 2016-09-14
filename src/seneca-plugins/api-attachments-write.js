'use strict';

const Promise = require( 'bluebird' );

Promise.config({
  cancellation: true
});

const bcrypt = require( 'bcryptjs' );
const db = require( '../db' );
const r = db.r;
const _ = require( 'lodash' );
const jwt = require( 'jsonwebtoken' );
const s3 = require( 'multer-storage-s3' );
const storage = s3({
  destination: '',
  filename: ''
});

module.exports = function () {

  // Promisify the seneca .act() method
  const act = Promise.promisify( this.act, { context: this });

  this.add( 'role:api,path:attachments,cmd:post', function( msg, done ) {

    if ( ! msg.body ) {

      done( null, {
        errors: [
          {
            title: 'Parameters not valid',
            detail: 'JSON body is missing.',
            propertyName: 'body',
            status: 400
          }
        ]
      });

      return;

    }

    if ( ! msg.file ) {

      done( null, {
        errors: [
          {
            title: 'Parameters not valid',
            detail: 'File is missing.',
            propertyName: 'attachment',
            status: 400
          }
        ]
      });

      return;

    }

    jwt.verify( msg.consumerJWT, process.env.JWT_SECRET, ( err, decoded ) => {

      if ( err || _.isEmpty( decoded.id ) ) {

        done( null, {
          errors: [
            {
              title: 'Unauthorized',
              detail: 'You are not authorized to do this.',
              status: 403
            }
          ]
        });

        return;

      }

      const file = msg.file,
        userId = decoded.id,
        parentId = msg.body.parentId,
        parentType = msg.body.parentType,
        parentSubtype = msg.body.parentSubtype;

      const attachment = {
        filename: file.filename,
        path: file.path,
        mimetype: file.mimetype,
        size: file.size,
        timestamp: r.now(),
        userId: userId,
        parentId: parentId,
        parentType: parentType,
        parentSubtype: parentSubtype
      };

      r
        .table( 'Attachment' )
        .insert( attachment, { returnChanges: true } )
        .run()
        .then( ( result ) => {

          if ( 0 === result.inserted ) {

            done( null, {
              errors: [
                {
                  title: 'Unknown error',
                  detail: 'Failed writing to database.',
                  status: 500
                }
              ]
            });

            return;

          }

          const data = result.changes[0].new_val;

          done( null, {
            data: data
          });

        })
        .catch( ( err ) => {

          done( err, null );

        });

    });

  });

  this.add( 'role:api,path:attachments,cmd:patch', function( msg, done ) {

    if ( ! msg.params || ! msg.params.id ) {

      done( null, {
        errors: [
          {
            title: 'Parameters not valid',
            detail: 'Attachment id is missing.',
            propertyName: 'id',
            status: 400
          }
        ]
      });

      return;

    }

    let currentState;

    const queryParams = {
        id: msg.params.id
      };

    const promise = act({
        role: 'api',
        path: 'attachments',
        type: 'read',
        cmd: 'getAttachments',
        args: queryParams,
        options: {}
      })
      .then( ( reply ) => {

        if ( _.isEmpty( reply.data ) ) {

          // Looks like this attachment does not exist

          done( null, { data: null });

          promise.cancel();

          return;

        }

        currentState = reply.data;

        return currentState;

      })
      .then( ( reply ) => {

        // Attachment exists, check if we are authorized to update this attachment

        return act({
          role: 'api',
          path: 'authorize',
          cmd: 'userCan',
          consumerJWT: msg.consumerJWT,
          what: 'attachments:edit',
          context: {
            owner: reply.userId
          }
        });

      })
      .then( ( reply ) => {

        if ( ! reply.can ) {

          done( null, {
            errors: [
              {
                title: 'Unauthorized',
                detail: 'You are not authorized to do this.',
                status: 403
              }
            ]
          });

          promise.cancel();

          return;

        }

        return;

      })
      .then( () => {

        const toUpdate = _.cloneDeep( msg.body ),
          updated = {},
          patchAttachmentPropsPromise = new Promise( ( resolve, reject ) => {

            function patchAttachmentProps() {

              if ( _.isEmpty( toUpdate ) ) {

                resolve( updated );

                return;

              }

              const prop = Object.keys( toUpdate )[0];

              if (
                'undefined' !== typeof currentState[ prop ] &&
                currentState[ prop ] === toUpdate[ prop ]
              ) {

                delete toUpdate[ prop ];

                return patchAttachmentProps();

              }

              if ( 'parentId' === prop ) {

                updated.parentId = toUpdate.parentId;

                delete toUpdate.parentId;

                patchAttachmentProps();

              } else if ( 'parentType' === prop ) {

                updated.parentType = toUpdate.parentType;

                delete toUpdate.parentType;

                patchAttachmentProps();

              } else if ( 'parentSubtype' === prop ) {

                updated.parentSubtype = toUpdate.parentSubtype;

                delete toUpdate.parentSubtype;

                patchAttachmentProps();

              } else {

                delete toUpdate[ prop ];

                return patchAttachmentProps();

              }

            }

            patchAttachmentProps();

          });

        return patchAttachmentPropsPromise;

      })
      .then( ( updated ) => {

        if ( ! _.isEmpty( updated.errors ) ) {

          done( null, {
            errors: updated.errors
          });

          promise.cancel();

          return;

        }

        if ( ! _.isEmpty( updated ) ) {

          return r
            .table( 'Attachment' )
            .get( currentState.id )
            .update( updated, { returnChanges: true })
            .run();

        }

        return {
          replaced: 0
        };

      })
      .then( ( result ) => {

        if ( 0 === result.replaced ) {

          const data = currentState;

          done( null, {
            data: data
          });

          return;

        }

        const data = result.changes[0].new_val;

        done( null, {
          data: data
        });

      })
      .catch( ( err ) => {

        done( err, null );

      });

  });

  this.add( 'role:api,path:attachments,cmd:delete', function( msg, done ) {

    if ( ! msg.params || ! msg.params.id ) {

      done( null, {
        errors: [
          {
            title: 'Parameters not valid',
            detail: 'Attachment id is missing.',
            propertyName: 'id',
            status: 400
          }
        ]
      });

      return;

    }

    let toDelete;

    const queryParams = {
      id: msg.params.id
    };

    const promise = act({
        role: 'api',
        path: 'attachments',
        type: 'read',
        cmd: 'getAttachments',
        args: queryParams,
        options: {}
      })
      .then( ( reply ) => {

        if ( _.isEmpty( reply.data ) ) {

          // Looks like this attachment does not exist

          done( null, {
            errors: [
              {
                title: 'Not found',
                detail: 'Attachment not found.',
                status: 404
              }
            ]
          });

          promise.cancel();

          return;

        }

        toDelete = reply.data;

        return toDelete;

      })
      .then( ( reply ) => {

        // Attachment exists, check if we are authorized to update this attachment

        return act({
          role: 'api',
          path: 'authorize',
          cmd: 'userCan',
          consumerJWT: msg.consumerJWT,
          what: 'attachments:edit',
          context: {
            owner: reply.userId
          }
        });

      })
      .then( ( reply ) => {

        if ( ! reply.can ) {

          done( null, {
            errors: [
              {
                title: 'Unauthorized',
                detail: 'You are not authorized to do this.',
                status: 403
              }
            ]
          });

          promise.cancel();

          return;

        }

        return;

      })
      .then( () => {

          return r
            .table( 'Attachment' )
            .get( toDelete.id )
            .delete({ returnChanges: true })
            .run();

      })
      .then( ( result ) => {

        done( null, {
          data: null
        });

        if ( 0 === result.deleted ) {

          return;

        }

        storage.s3obj.deleteObjects(
          {
            Bucket: storage.options.bucket,
            Delete: {
              Objects: [
                {
                  Key: toDelete.path
                }
              ]
            }
          },
          () => {

            // Do nothing here (for now?)

          }
        );

      })
      .catch( ( err ) => {

        done( err, null );

      });

  });

  return {
    name: 'api-attachments-write'
  };

};
