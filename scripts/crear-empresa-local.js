const bcrypt = require('bcryptjs');
const pool = require('../src/config/db');

(async () => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const nit = '12345';
    const [exist] = await conn.query('SELECT id_empresa FROM empresas WHERE nit = ?', [nit]);
    let idEmpresa;

    if (exist.length) {
      idEmpresa = exist[0].id_empresa;
      console.log('Empresa ya existía, id=', idEmpresa);
    } else {
      const [ins] = await conn.query(
        `INSERT INTO empresas (nombre, nit, direccion, telefono, email, plan, activa)
         VALUES (?, ?, ?, ?, ?, 'premium', TRUE)`,
        ['Parqueadero Lector Placas', nit, 'Local', '3000000000', 'admin@local.com']
      );
      idEmpresa = ins.insertId;
      console.log('Empresa creada, id=', idEmpresa);
    }

    const [cfg] = await conn.query(
      'SELECT id_configuracion FROM configuracion_empresa WHERE id_empresa = ?',
      [idEmpresa]
    );
    if (!cfg.length) {
      await conn.query(
        `INSERT INTO configuracion_empresa
         (id_empresa, capacidad_total_carros, capacidad_total_motos, capacidad_total_bicicletas, operacion_24h)
         VALUES (?, 100, 50, 0, TRUE)`,
        [idEmpresa]
      );
    }

    const tipos = [
      { nombre: 'Carro', codigo: 'carro', cap: 100, vh: 6000, vm: 120, vd: 30000 },
      { nombre: 'Moto', codigo: 'moto', cap: 50, vh: 3000, vm: 60, vd: 15000 }
    ];

    for (const t of tipos) {
      const [rows] = await conn.query(
        'SELECT id_tipo FROM tipos_vehiculos WHERE id_empresa = ? AND codigo = ?',
        [idEmpresa, t.codigo]
      );
      let idTipo;
      if (rows.length) {
        idTipo = rows[0].id_tipo;
      } else {
        const [insT] = await conn.query(
          'INSERT INTO tipos_vehiculos (id_empresa, nombre, codigo, activo) VALUES (?, ?, ?, TRUE)',
          [idEmpresa, t.nombre, t.codigo]
        );
        idTipo = insT.insertId;
      }

      const [cap] = await conn.query(
        'SELECT id_capacidad FROM capacidades_tipo WHERE id_empresa = ? AND id_tipo = ?',
        [idEmpresa, idTipo]
      );
      if (!cap.length) {
        await conn.query(
          'INSERT INTO capacidades_tipo (id_empresa, id_tipo, capacidad_total) VALUES (?, ?, ?)',
          [idEmpresa, idTipo, t.cap]
        );
      }

      const [tar] = await conn.query(
        'SELECT id_tarifa FROM tarifas WHERE id_empresa = ? AND id_tipo = ? AND activa = TRUE',
        [idEmpresa, idTipo]
      );
      if (!tar.length) {
        await conn.query(
          `INSERT INTO tarifas
           (id_empresa, id_tipo, valor_hora, valor_minuto, valor_dia_completo, activa)
           VALUES (?, ?, ?, ?, ?, TRUE)`,
          [idEmpresa, idTipo, t.vh, t.vm, t.vd]
        );
      }
    }

    const hash = await bcrypt.hash('admin123', 10);
    const [users] = await conn.query(
      'SELECT id_usuario FROM usuarios WHERE id_empresa = ? AND usuario_login = ?',
      [idEmpresa, 'admin']
    );

    if (users.length) {
      await conn.query(
        'UPDATE usuarios SET contraseña = ?, nombre = ?, rol = ?, activo = TRUE WHERE id_usuario = ?',
        [hash, 'Administrador', 'admin', users[0].id_usuario]
      );
      console.log('Usuario admin actualizado');
    } else {
      await conn.query(
        `INSERT INTO usuarios (id_empresa, nombre, usuario_login, contraseña, rol, activo)
         VALUES (?, ?, ?, ?, ?, TRUE)`,
        [idEmpresa, 'Administrador', 'admin', hash, 'admin']
      );
      console.log('Usuario admin creado');
    }

    await conn.commit();
    console.log('OK');
    console.log('NIT: 12345');
    console.log('Usuario: admin');
    console.log('Password: admin123');
  } catch (e) {
    await conn.rollback();
    console.error('FAIL', e.message);
    process.exitCode = 1;
  } finally {
    conn.release();
    await pool.end();
  }
})();
