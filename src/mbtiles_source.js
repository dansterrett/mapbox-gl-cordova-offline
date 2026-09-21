import VectorTileSource from 'mapbox-gl/src/source/vector_tile_source'
import pako from 'pako/lib/inflate'
import base64js from 'base64-js'
import Database from './database'

class MBTilesSource extends VectorTileSource {

    constructor(id, options, dispatcher, eventedParent) {
        super(id, options, dispatcher, eventedParent);
        this.type = "mbtiles";
        this.db = this.openDatabase(options.path);
        // this.maxzoom = 14;
    }

    openDatabase(dbLocation) {
        return Database.openDatabase(dbLocation)
    }

    copyDatabaseFile(dbLocation, dbName, targetDir) {
        return Database.copyDatabaseFile(dbLocation, dbName, targetDir)
    }

    readTile(z, x, y, callback) {
        if (!window.device || device.platform === 'browser') {
          const query = 'SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?';
          const params = [z, x, y];
          this.db.then(function(db) {
            db.each(query, params, function(result) {
              const rawData = pako.inflate(result.tile_data);
              callback(undefined, base64js.fromByteArray(rawData)); // Tile contents read, callback success.
            }, function (done) {
              // Do nothing
            });
          }).catch(function(err) {
            callback(err);
          });

          return;
        }

        // Use hex() instead of BASE64() — hex() is available in all SQLite drivers including
        // Android's built-in sqlite, whereas BASE64() is only in the NDK driver.
        const query = 'SELECT hex(tile_data) AS hex_tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?';
        const params = [z, x, y];
        this.db.then(function(db) {
            db.transaction(function (txn) {
                txn.executeSql(query, params, function (tx, res) {
                    if (res.rows.length) {
                      const hexData = res.rows.item(0).hex_tile_data;
                      const bytes = new Uint8Array(hexData.length / 2);
                      for (let i = 0; i < hexData.length; i += 2) {
                          bytes[i / 2] = parseInt(hexData.substring(i, i + 2), 16);
                      }
                      const rawData = pako.inflate(bytes);
                      callback(undefined, base64js.fromByteArray(rawData)); // Tile contents read, callback success.
                    } else {
                        callback(new Error('tile ' + params.join(',') + ' not found'));
                    }
                });
            }, function (error) {
                callback(error); // Error executing SQL
            });
        }).catch(function(err) {
            callback(err);
        });
    }

    loadTile(tile, callback) {
        const coord = tile.tileID.canonical;
        const overscaling = coord.z > this.maxzoom ? Math.pow(2, coord.z - this.maxzoom) : 1;

        const z = Math.min(coord.z, this.maxzoom || coord.z); // Don't try to get data over maxzoom
        const x = coord.x;
        const y = Math.pow(2,z)-coord.y-1; // Tiles on database are tms (inverted y axis)

        this.readTile(z, x, y, dispatch.bind(this));

        function dispatch(err, base64Data) {
            if (err) {
                return callback(err);
            }
            if (base64Data === undefined) {
              return callback(new Error("empty data"));
            }

            const params = {
                request: { url: "data:application/x-protobuf;base64," + base64Data },
                uid: tile.uid,
                tileID: tile.tileID,
                zoom: coord.z,
                tileSize: this.tileSize * overscaling,
                type: this.type,
                source: this.id,
                pixelRatio: window.devicePixelRatio || 1,
                overscaling: overscaling,
                showCollisionBoxes: this.map.showCollisionBoxes
            };

            if (!tile.actor || tile.state === 'expired') {
                tile.actor = this.dispatcher.getActor();
                tile.request = tile.actor.send('loadTile', params, done.bind(this));
            } else if (tile.state === 'loading') {
                // schedule tile reloading after it has been loaded
                tile.reloadCallback = callback;
            } else {
                tile.request = tile.actor.send('reloadTile', params, done.bind(this));
            }

            function done(err, data) {
                if (tile.aborted)
                    return;

                if (err) {
                    return callback(err);
                }

                if (this.map._refreshExpiredTiles) tile.setExpiryData(data);
                tile.loadVectorData(data, this.map.painter);

                callback(null);

                if (tile.reloadCallback) {
                    this.loadTile(tile, tile.reloadCallback);
                    tile.reloadCallback = null;
                }
            }
        }
    }
}

export default MBTilesSource;
